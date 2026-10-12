import {
    LocalVault,
    SearchIndex,
    Vault,
    applyIndexChange,
    watchMarkdownFiles,
    type LocalVaultWatcher,
    type VaultBackend,
    type VaultContext,
} from "@couchloom/core";
import { hashDocumentContent, type VectorDocumentState } from "@couchloom/rag";
import { join } from "node:path";
import type { AppVaultConfig } from "./vault-config.js";
import type { RagIndexJob, RagQueueStats } from "./rag-job-queue.js";
import { buildDisabledRagStatus, buildRagIndexStatus, summarizeRagError, type RagIndexStatus } from "./rag-status.js";

export interface RagQueueClient {
    enqueue(job: RagIndexJob): Promise<void>;
    stats?(vaultId?: string): Promise<RagQueueStats>;
}

export interface RagInventoryClient {
    readonly model: string;
    listDocuments(vaultId: string): Promise<VectorDocumentState[]>;
    countDocuments(vaultId: string): Promise<number>;
}

export interface VaultRuntimeDependencies {
    backend?: VaultBackend;
    ragQueue?: RagQueueClient;
    ragInventory?: RagInventoryClient;
    ragApply?: (vaultId: string, path: string, content: string | null, mtime?: number) => Promise<void>;
}

export class VaultRuntime {
    readonly config: AppVaultConfig;
    readonly backend: VaultBackend;
    readonly searchIndex: SearchIndex;
    readonly context: VaultContext;
    #watcher: LocalVaultWatcher | null = null;
    #debug: boolean;
    #ragQueue?: RagQueueClient;
    #ragInventory?: RagInventoryClient;
    #ragApply?: VaultRuntimeDependencies["ragApply"];
    #reconciliation: Promise<void> | null = null;
    #lastSuccessAt: string | null = null;
    #lastError: string | null = null;
    #lastReconciliationAt: string | null = null;

    constructor(
        config: AppVaultConfig,
        baseDataDir: string,
        debug = false,
        dependencies: VaultRuntimeDependencies = {},
    ) {
        this.config = config;
        this.#debug = debug;
        this.#ragQueue = dependencies.ragQueue;
        this.#ragInventory = dependencies.ragInventory;
        this.#ragApply = dependencies.ragApply;
        this.backend = dependencies.backend ?? (config.mode === "local"
            ? new LocalVault(config.path)
            : new Vault({
                couchdbUrl: config.url,
                couchdbUser: config.user,
                couchdbPassword: config.password,
                database: config.database,
                passphrase: config.passphrase,
                obfuscatePaths: config.obfuscatePaths,
            }));
        this.searchIndex = new SearchIndex(join(baseDataDir, config.id, "search-index.json"), config.mode === "couchdb" ? config.passphrase : undefined);
        this.context = {
            id: config.id,
            name: config.name,
            backend: this.backend,
            searchIndex: this.searchIndex,
            onDocumentChange: this.#ragQueue
                ? (path, _content, mtime) => this.enqueueRag(path, mtime)
                : undefined,
        };
    }

    async start(): Promise<void> {
        await this.backend.init();
        await this.searchIndex.loadFromDisk();
        await this.#rebuildIndex();
        console.log(`[vault:${this.config.id}] Search index built: ${this.searchIndex.size} notes.`);
        await this.#startWatcher();
        console.log(`[vault:${this.config.id}] ready (${this.config.mode}).`);
    }

    async save(): Promise<void> {
        await this.searchIndex.saveToDisk();
    }

    async close(): Promise<void> {
        if (this.#watcher) await this.#watcher.close();
        await this.save();
        await this.backend.close();
    }

    async #rebuildIndex(): Promise<void> {
        if (this.config.mode === "couchdb" && this.backend.catchUp) {
            const apply = async (path: string, content: string | null, mtime?: number) => {
                applyIndexChange(this.searchIndex, path, content, mtime);
                await this.enqueueRag(path, mtime);
            };
            const onBatch = async (since: string) => {
                this.searchIndex.since = since;
                await this.save();
            };
            try {
                this.searchIndex.since = await this.backend.catchUp(this.searchIndex.since || "0", apply, onBatch);
            } catch (error) {
                console.warn(`[vault:${this.config.id}] catch-up failed; rebuilding from zero: ${(error as Error).message}`);
                this.searchIndex.clear();
                this.searchIndex.since = await this.backend.catchUp("0", apply, onBatch);
            }
            await this.save();
            return;
        }

        const notes = await this.backend.listNotesWithMtime();
        const present = new Set(notes.map(({ path }) => path));
        for (const path of this.searchIndex.listPaths()) {
            if (!present.has(path)) {
                this.searchIndex.remove(path);
                await this.enqueueRag(path);
            }
        }
        for (const { path, mtime } of notes) {
            const content = await this.backend.readNote(path);
            if (content !== null) this.searchIndex.update(path, content, mtime);
            if (content !== null) await this.enqueueRag(path, mtime);
        }
        await this.save();
    }

    async #startWatcher(): Promise<void> {
        if (this.config.mode === "local") {
            const pending = new Map<string, ReturnType<typeof setTimeout>>();
            this.#watcher = watchMarkdownFiles(this.config.path, (path) => {
                const current = pending.get(path);
                if (current) clearTimeout(current);
                pending.set(path, setTimeout(() => void (async () => {
                    pending.delete(path);
                    const content = await this.backend.readNote(path);
                    if (content === null) this.searchIndex.remove(path);
                    else this.searchIndex.update(path, content, Date.now());
                    await this.enqueueRag(path, Date.now());
                })().catch((error) => {
                    console.error(`[vault:${this.config.id}] change enqueue failed: ${(error as Error).message}`);
                }), 100));
            });
            return;
        }

        await this.backend.watchChanges?.(async (path, content, mtime, seq) => {
            if (this.#debug) console.log(`[vault:${this.config.id}] ${content === null ? "delete" : "change"}: ${path}`);
            applyIndexChange(this.searchIndex, path, content, mtime);
            await this.enqueueRag(path, mtime);
            if (seq !== undefined) this.searchIndex.since = String(seq);
        });
    }

    async enqueueRag(path: string, mtime?: number): Promise<void> {
        if (!this.#ragQueue) return;
        await this.#ragQueue.enqueue({ vaultId: this.config.id, path, observedMtime: mtime });
    }

    async processRagJob(path: string): Promise<void> {
        if (!this.#ragApply) return;
        const content = await this.backend.readNote(path);
        const metadata = content === null ? null : await this.backend.getMetadata(path);
        try {
            await this.#ragApply(this.config.id, path, content, metadata?.mtime);
            this.#lastSuccessAt = new Date().toISOString();
            this.#lastError = null;
        } catch (error) {
            this.#lastError = summarizeRagError(error);
            throw error;
        }
    }

    reconcileRag(): Promise<void> {
        if (this.#reconciliation) return this.#reconciliation;
        const reconciliation = this.#runReconciliation().finally(() => {
            if (this.#reconciliation === reconciliation) this.#reconciliation = null;
        });
        this.#reconciliation = reconciliation;
        return reconciliation;
    }

    async stopRagReconciliation(): Promise<void> {
        await this.#reconciliation;
    }

    async getRagStatus(): Promise<RagIndexStatus> {
        const expected = (await this.backend.listNotesWithMtime()).length;
        const checkpoint = this.searchIndex.since || null;
        if (!this.#ragInventory || !this.#ragQueue?.stats) return buildDisabledRagStatus(expected, checkpoint);
        const [documents, queue] = await Promise.all([
            this.#ragInventory.listDocuments(this.config.id),
            this.#ragQueue.stats(this.config.id),
        ]);
        const persistedLastSuccess = documents.reduce<string | null>(
            (latest, document) => !latest || document.updatedAt > latest ? document.updatedAt : latest,
            null,
        );
        return buildRagIndexStatus({
            model: this.#ragInventory.model,
            expected,
            indexed: documents.length,
            queue,
            checkpoint,
            lastSuccessAt: this.#lastSuccessAt ?? persistedLastSuccess,
            lastError: this.#lastError,
            lastReconciliationAt: this.#lastReconciliationAt,
        });
    }

    async #runReconciliation(): Promise<void> {
        if (!this.#ragInventory || !this.#ragQueue) return;
        try {
            const [sourceNotes, documents] = await Promise.all([
                this.backend.listNotesWithMtime(),
                this.#ragInventory.listDocuments(this.config.id),
            ]);
            const sourceByPath = new Map(sourceNotes.map((note) => [note.path, note]));
            const documentsByPath = new Map(documents.map((document) => [document.path, document]));

            for (const note of sourceNotes) {
                const content = await this.backend.readNote(note.path);
                const document = documentsByPath.get(note.path);
                const needsIndex = content === null
                    || !document
                    || document.contentHash !== hashDocumentContent(content)
                    || document.embeddingModel !== this.#ragInventory.model;
                if (needsIndex) await this.enqueueRag(note.path, note.mtime);
            }
            for (const document of documents) {
                if (!sourceByPath.has(document.path)) await this.enqueueRag(document.path);
            }
            this.#lastReconciliationAt = new Date().toISOString();
        } catch (error) {
            this.#lastError = summarizeRagError(error);
            throw error;
        }
    }
}
