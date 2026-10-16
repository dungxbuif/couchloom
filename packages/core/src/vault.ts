/**
 * Vault access layer — wraps DirectFileManipulator from livesync-commonlib.
 */

import { DirectFileManipulator } from "../lib/livesync-commonlib/src/API/DirectFileManipulator.ts";
import type { DirectFileManipulatorOptions } from "../lib/livesync-commonlib/src/API/DirectFileManipulator.ts";
import { createTextBlob } from "../lib/livesync-commonlib/src/common/utils.ts";
import type { FilePathWithPrefix } from "../lib/livesync-commonlib/src/common/types.ts";
import type { MetaEntry } from "../lib/livesync-commonlib/src/API/DirectFileManipulatorV2.ts";
import { isPathProbablyObfuscated, decrypt } from "octagonal-wheels/encryption/encryption";
import { clearHandlers } from "../lib/livesync-commonlib/src/replication/SyncParamsHandler.ts";
import { parseFrontmatterAndLinks } from "./parse.js";
import type { VaultBackend, NoteInfo, NoteListing, VaultChangeCallback } from "./vault-backend.js";
import { deriveContent } from "./index-sync.js";
import { classifyIds, type IdFormat } from "./id-format.js";
import { AcknowledgedChangeStream } from "./change-ack.js";

export interface VaultConfig {
    couchdbUrl: string;
    couchdbUser: string;
    couchdbPassword: string;
    database: string;
    passphrase?: string;
    obfuscatePaths?: boolean;
}

export function createLiveSyncTextBlob(content: string): Blob {
    const blob = createTextBlob(content);
    // Bun normalizes text/plain to text/plain;charset=utf-8, while the vendored
    // LiveSync splitter recognizes only the exact MIME value.
    if (blob.type !== "text/plain" && blob.type.startsWith("text/plain;")) {
        Object.defineProperty(blob, "type", { value: "text/plain" });
    }
    return blob;
}

export class Vault implements VaultBackend {
    private manipulator: DirectFileManipulator;
    private passphrase: string | undefined;
    private config: VaultConfig;
    private watchedPaths = new Map<string, string>();
    private liveChanges: any;
    private acknowledgedChanges?: AcknowledgedChangeStream;
    private watchReconnectTimer?: ReturnType<typeof setTimeout>;
    private closing = false;

    constructor(config: VaultConfig) {
        this.config = config;
        this.passphrase = config.passphrase;
        this.manipulator = new DirectFileManipulator(Vault.buildOptions(config, !!config.obfuscatePaths));
    }

    private static buildOptions(config: VaultConfig, obfuscatePaths: boolean): DirectFileManipulatorOptions {
        return {
            url: config.couchdbUrl,
            username: config.couchdbUser,
            password: config.couchdbPassword,
            database: config.database,
            passphrase: config.passphrase,
            obfuscatePassphrase: obfuscatePaths ? config.passphrase : undefined,
            useEden: false,
            enableCompression: false,
            handleFilenameCaseSensitive: false,
            doNotUseFixedRevisionForChunks: false,
        };
    }

    async init(): Promise<void> {
        await this.manipulator.ready.promise;
        await this.reconcileObfuscation();
    }

    /**
     * Detect whether the vault's document IDs are obfuscated and, if the
     * configured COUCHDB_OBFUSCATE_PROPERTIES doesn't match, correct it.
     * A mismatched setting can never work: path→id resolution misses every
     * existing note on read, and writes produce docs LiveSync clients ignore
     * (issues #4, #10). The database is the ground truth.
     */
    private async reconcileObfuscation(): Promise<void> {
        const configured = !!this.config.obfuscatePaths;
        const format = await this.detectIdFormat();
        if (format === "empty") return;
        if (format === "mixed") {
            console.warn(
                "Warning: vault contains both obfuscated and plaintext document IDs. " +
                `Keeping COUCHDB_OBFUSCATE_PROPERTIES=${configured}. ` +
                "This usually means \"Obfuscate properties\" was toggled without rebuilding the database — consider rebuilding it from LiveSync.",
            );
            return;
        }
        const actual = format === "obfuscated";
        if (actual === configured) return;
        if (actual && !this.passphrase) {
            throw new Error(
                "Vault uses obfuscated document IDs (LiveSync \"Obfuscate properties\"), which requires the E2E passphrase. " +
                "Set COUCHDB_PASSPHRASE and COUCHDB_OBFUSCATE_PROPERTIES=true.",
            );
        }
        console.warn(
            actual
                ? "Warning: vault uses obfuscated document IDs but COUCHDB_OBFUSCATE_PROPERTIES is not set to true. " +
                  "Enabling path obfuscation automatically — set COUCHDB_OBFUSCATE_PROPERTIES=true to silence this warning."
                : "Warning: COUCHDB_OBFUSCATE_PROPERTIES=true but vault uses plaintext document IDs. " +
                  "Disabling path obfuscation automatically — set COUCHDB_OBFUSCATE_PROPERTIES=false to silence this warning.",
        );
        await this.manipulator.close();
        this.manipulator = new DirectFileManipulator(Vault.buildOptions(this.config, actual));
        await this.manipulator.ready.promise;
    }

    /** Sample file-entry docs from the changes feed and classify their IDs. */
    private async detectIdFormat(): Promise<IdFormat> {
        const SAMPLE_TARGET = 20;
        const BATCH_SIZE = 100;
        const db = this.manipulator.liveSyncLocalDB.localDatabase;
        const ids: string[] = [];
        let since: string | number = 0;

        while (ids.length < SAMPLE_TARGET) {
            const result: {
                results: Array<{ id: string }>;
                last_seq: string | number;
            } = await db.changes({
                since,
                limit: BATCH_SIZE,
                // Only real file entries — excludes chunks, versioninfo, milestones, sync params.
                selector: { type: { $in: ["plain", "newnote"] } },
                live: false,
            });
            for (const change of result.results) {
                if (ids.length >= SAMPLE_TARGET) break;
                ids.push(change.id);
            }
            if (result.results.length < BATCH_SIZE) break;
            since = result.last_seq;
        }
        return classifyIds(ids);
    }

    async close(): Promise<void> {
        this.closing = true;
        if (this.watchReconnectTimer) clearTimeout(this.watchReconnectTimer);
        this.liveChanges?.cancel();
        await this.acknowledgedChanges?.drain().catch(() => undefined);
        this.manipulator.endWatch();
        await this.manipulator.close();
    }

    private static mdFilter(meta: any): boolean {
        return (meta.path ?? "").endsWith(".md");
    }

    private static async docToChange(doc: any, callback: VaultChangeCallback, seq?: string | number): Promise<void> {
        const path = doc.path ?? "";
        if (!path.endsWith(".md")) return;
        // null => deleted (remove); "" => existing empty note (index it, don't drop)
        const content = deriveContent(doc);
        await callback(path, content, content === null ? undefined : doc.mtime, seq);
    }

    async catchUp(
        since: string,
        callback: VaultChangeCallback,
        onBatch?: (since: string, processed: number) => Promise<void>,
    ): Promise<string> {
        // Paginate _changes in batches to limit memory usage.
        const BATCH_SIZE = 50;
        const db = this.manipulator.liveSyncLocalDB.localDatabase;
        let currentSince = since;
        let totalProcessed = 0;

        while (true) {
            const result = await db.changes({
                include_docs: true,
                since: currentSince,
                selector: { type: { $ne: "leaf" } },
                live: false,
                limit: BATCH_SIZE,
            });

            for (const change of result.results) {
                if (!change.doc) continue;
                const meta = change.doc as any;
                // Skip chunks and system docs
                if (meta.type === "leaf" || meta.type === "versioninfo") continue;
                if (meta._id?.startsWith("h:") || meta._id?.startsWith("_")) continue;
                // Decrypt path to check .md BEFORE fetching chunks (avoids loading large attachments)
                let path = meta.path ?? "";
                if (isPathProbablyObfuscated(path) && this.passphrase) {
                    try { path = await decrypt(path, this.passphrase, false); } catch { continue; }
                }
                if (!path.endsWith(".md") && !meta.deleted) continue;
                const doc = await this.manipulator.getByMeta(meta).catch(() => null);
                if (doc) await Vault.docToChange(doc, callback, change.seq);
            }

            totalProcessed += result.results.length;
            currentSince = String(result.last_seq);

            // Release chunk cache between batches to prevent memory growth
            this.manipulator.liveSyncLocalDB.clearCaches();

            // Save checkpoint after each batch so crashes don't restart from zero
            if (onBatch && result.results.length > 0) {
                await onBatch(currentSince, totalProcessed);
            }

            // No more changes
            if (result.results.length < BATCH_SIZE) break;
        }

        this.manipulator.since = currentSince;
        return currentSince;
    }

    async watchChanges(callback: VaultChangeCallback): Promise<void> {
        // Hard CouchDB tombstones only retain _id/_rev/_deleted. Build this map
        // before opening the feed so external hard deletes can still evict the
        // corresponding metadata and vector rows.
        for await (const doc of this.manipulator.enumerateAllNormalDocs({ metaOnly: true })) {
            const meta = doc as MetaEntry;
            if (meta._id && Vault.mdFilter(meta)) this.watchedPaths.set(meta._id, meta.path);
        }

        // catchUp already set this.manipulator.since to the right point
        const start = () => {
            const generation = new AcknowledgedChangeStream(String(this.manipulator.since || "0"));
            this.acknowledgedChanges = generation;
            let retiring = false;
            const feed = this.manipulator.liveSyncLocalDB.localDatabase.changes({
                include_docs: true,
                since: generation.checkpoint,
                live: true,
            });
            this.liveChanges = feed;

            const retire = () => {
                if (retiring || this.closing || this.acknowledgedChanges !== generation) return;
                retiring = true;
                feed.cancel();
                void generation
                    .drain()
                    .catch(() => undefined)
                    .finally(() => {
                        if (this.closing || this.acknowledgedChanges !== generation) return;
                        this.manipulator.since = generation.checkpoint;
                        this.acknowledgedChanges = undefined;
                        this.watchReconnectTimer = setTimeout(start, 10_000);
                    });
            };

            feed
                .on("change", (change: any) => {
                    if (retiring || this.acknowledgedChanges !== generation) return;
                    void generation.enqueue(String(change.seq), async () => {
                        const doc = change.doc;
                        if (!doc) return;
                        if (doc._deleted) {
                            const path = this.watchedPaths.get(doc._id);
                            if (!path) return;
                            await callback(path, null, undefined, change.seq);
                            this.watchedPaths.delete(doc._id);
                            return;
                        }
                        if (doc.type === "leaf" || doc.type === "versioninfo" || !Vault.mdFilter(doc)) return;
                        if (doc._id) this.watchedPaths.set(doc._id, doc.path);
                        const ready = await this.manipulator.getByMeta(doc).catch(() => null);
                        if (ready) await Vault.docToChange(ready, callback, change.seq);
                    })
                        .then(() => {
                            if (this.acknowledgedChanges === generation) this.manipulator.since = generation.checkpoint;
                        })
                        .catch(retire);
                })
                .on("error", retire);
        };
        start();
    }

    private validatePath(path: string): void {
        if (!path || path.startsWith("/") || path.includes("\0") || path.includes("..") || path.length > 1000) {
            throw new Error("Invalid path");
        }
    }

    async readNote(path: string): Promise<string | null> {
        this.validatePath(path);
        const entry = await this.manipulator.get(path as FilePathWithPrefix);
        if (!entry) return null;
        if ("data" in entry && Array.isArray(entry.data)) {
            return entry.data.join("");
        }
        return null;
    }

    async writeNote(path: string, content: string): Promise<boolean> {
        this.validatePath(path);
        // Clear cached PBKDF2 salt so we re-fetch from CouchDB before encrypting.
        // Prevents stale salt after Obsidian "Overwrite remote" rebuilds (issue #686).
        clearHandlers();

        // Preserve ctime if note already exists
        let ctime = Date.now();
        const existing = await this.manipulator.get(path as FilePathWithPrefix, true);
        if (existing && "ctime" in existing) {
            ctime = existing.ctime;
        }

        const blob = createLiveSyncTextBlob(content);
        return await this.manipulator.put(path, blob, {
            ctime,
            mtime: Date.now(),
            size: new TextEncoder().encode(content).byteLength,
        });
    }

    async createNote(path: string, content: string): Promise<boolean> {
        this.validatePath(path);
        clearHandlers();
        const now = Date.now();
        try {
            const ok = await this.manipulator.put(path, createLiveSyncTextBlob(content), {
                ctime: now,
                mtime: now,
                size: new TextEncoder().encode(content).byteLength,
            }, "plain", true);
            if (!ok) throw new Error("Failed to create note");
            return true;
        } catch (error: any) {
            if (error.status === 409 || error.name === "conflict") return false;
            throw error;
        }
    }

    async deleteNote(path: string): Promise<boolean> {
        this.validatePath(path);
        clearHandlers();
        return await this.manipulator.delete(path);
    }

    async moveNote(from: string, to: string): Promise<boolean> {
        this.validatePath(from);
        this.validatePath(to);
        const content = await this.readNote(from);
        if (content === null) return false;
        const wrote = await this.writeNote(to, content);
        if (!wrote) return false;
        return await this.deleteNote(from);
    }

    async getMetadata(path: string): Promise<NoteInfo | null> {
        this.validatePath(path);
        const entry = await this.manipulator.get(path as FilePathWithPrefix);
        if (!entry) return null;
        const content = "data" in entry && Array.isArray(entry.data) ? entry.data.join("") : "";
        return {
            path,
            size: entry.size,
            ctime: entry.ctime,
            mtime: entry.mtime,
            ...parseFrontmatterAndLinks(content),
        };
    }

    async listNotes(folder?: string): Promise<string[]> {
        const notes = await this.listNotesWithMtime(folder);
        return notes.map((n) => n.path);
    }

    async listNotesWithMtime(folder?: string): Promise<NoteListing[]> {
        if (folder && !folder.endsWith("/")) folder += "/";
        const results: NoteListing[] = [];
        for await (const doc of this.manipulator.enumerateAllNormalDocs({ metaOnly: true })) {
            const entry = doc as MetaEntry;
            if (entry.deleted) continue;
            const notePath = entry.path ?? "";
            if (!notePath.endsWith(".md")) continue;
            if (folder && !notePath.startsWith(folder)) continue;
            results.push({ path: notePath, mtime: entry.mtime ?? 0 });
        }
        return results.sort((a, b) => a.path.localeCompare(b.path));
    }

}
