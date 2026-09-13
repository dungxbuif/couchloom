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
import { join } from "node:path";
import type { AppVaultConfig } from "./vault-config.js";

export class VaultRuntime {
    readonly config: AppVaultConfig;
    readonly backend: VaultBackend;
    readonly searchIndex: SearchIndex;
    readonly context: VaultContext;
    #watcher: LocalVaultWatcher | null = null;
    #debug: boolean;

    constructor(config: AppVaultConfig, baseDataDir: string, debug = false) {
        this.config = config;
        this.#debug = debug;
        this.backend = config.mode === "local"
            ? new LocalVault(config.path)
            : new Vault({
                couchdbUrl: config.url,
                couchdbUser: config.user,
                couchdbPassword: config.password,
                database: config.database,
                passphrase: config.passphrase,
                obfuscatePaths: config.obfuscatePaths,
            });
        this.searchIndex = new SearchIndex(join(baseDataDir, config.id, "search-index.json"), config.mode === "couchdb" ? config.passphrase : undefined);
        this.context = { id: config.id, name: config.name, backend: this.backend, searchIndex: this.searchIndex };
    }

    async start(): Promise<void> {
        await this.backend.init();
        await this.searchIndex.loadFromDisk();
        await this.#rebuildIndex();
        console.log(`[vault:${this.config.id}] Search index built: ${this.searchIndex.size} notes.`);
        this.#startWatcher();
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
            const apply = (path: string, content: string | null, mtime?: number) => applyIndexChange(this.searchIndex, path, content, mtime);
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
        for (const path of this.searchIndex.listPaths()) if (!present.has(path)) this.searchIndex.remove(path);
        for (const { path, mtime } of notes) {
            const content = await this.backend.readNote(path);
            if (content !== null) this.searchIndex.update(path, content, mtime);
        }
        await this.save();
    }

    #startWatcher(): void {
        if (this.config.mode === "local") {
            const pending = new Map<string, ReturnType<typeof setTimeout>>();
            this.#watcher = watchMarkdownFiles(this.config.path, (path) => {
                const current = pending.get(path);
                if (current) clearTimeout(current);
                pending.set(path, setTimeout(async () => {
                    pending.delete(path);
                    const content = await this.backend.readNote(path);
                    if (content === null) this.searchIndex.remove(path);
                    else this.searchIndex.update(path, content, Date.now());
                }, 100));
            });
            return;
        }

        this.backend.watchChanges?.((path, content, mtime, seq) => {
            if (this.#debug) console.log(`[vault:${this.config.id}] ${content === null ? "delete" : "change"}: ${path}`);
            applyIndexChange(this.searchIndex, path, content, mtime);
            if (seq !== undefined) this.searchIndex.since = String(seq);
        });
    }
}
