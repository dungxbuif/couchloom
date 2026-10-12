import { afterEach, describe, expect, test } from "bun:test";
import { hashDocumentContent, type VectorDocumentState } from "@couchloom/rag";
import type { NoteInfo, VaultBackend } from "@couchloom/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RagIndexJob, RagQueueStats } from "../../src/rag-job-queue.js";
import { VaultRuntime } from "../../src/vault-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("RAG reconciliation", () => {
    test("enqueues missing, stale, model-mismatched, empty, and orphan documents", async () => {
        const backend = new InventoryBackend({
            "missing.md": "missing",
            "stale.md": "fresh stale content",
            "model.md": "same model content",
            "current.md": "already current",
            "empty.md": "",
        });
        const inventory = new FakeInventory("nomic-embed-text", [
            document("stale.md", "old-hash", "nomic-embed-text"),
            document("model.md", hashDocumentContent("same model content"), "old-model"),
            document("current.md", hashDocumentContent("already current"), "nomic-embed-text"),
            document("orphan.md", "orphan-hash", "nomic-embed-text"),
        ]);
        const queue = new StatusQueue();
        const runtime = await createRuntime(backend, queue, inventory);

        await runtime.reconcileRag();

        expect(queue.jobs.map(({ path }) => path).sort()).toEqual([
            "empty.md",
            "missing.md",
            "model.md",
            "orphan.md",
            "stale.md",
        ]);
        expect(queue.jobs.find(({ path }) => path === "empty.md")?.observedMtime).toBe(10);
        expect(queue.jobs.some(({ path }) => path === "current.md")).toBe(false);
    });

    test("prevents overlapping reconciliation scans", async () => {
        const backend = new InventoryBackend({ "note.md": "content" });
        const inventory = new FakeInventory("nomic-embed-text", []);
        const gate = deferred<void>();
        inventory.beforeList = () => gate.promise;
        const queue = new StatusQueue();
        const runtime = await createRuntime(backend, queue, inventory);

        const first = runtime.reconcileRag();
        const second = runtime.reconcileRag();
        await Bun.sleep(0);
        expect(inventory.listCalls).toBe(1);
        let stopped = false;
        const stopping = runtime.stopRagReconciliation().then(() => {
            stopped = true;
        });
        await Bun.sleep(0);
        expect(stopped).toBe(false);

        gate.resolve();
        await Promise.all([first, second, stopping]);
        expect(stopped).toBe(true);
        expect(queue.jobs).toHaveLength(1);
    });

    test("reports permanent failures as degraded without leaking note paths", async () => {
        const backend = new InventoryBackend({ "private/failure.md": "content" });
        const inventory = new FakeInventory("nomic-embed-text", []);
        const queue = new StatusQueue();
        queue.currentStats = {
            queued: 0,
            active: 0,
            retrying: 0,
            failed: 1,
            oldestQueuedAt: null,
        };
        const runtime = await createRuntime(backend, queue, inventory, async () => {
            throw new Error("embedding failed for private/failure.md");
        });

        await expect(runtime.processRagJob("private/failure.md")).rejects.toThrow();
        const status = await runtime.getRagStatus();

        expect(status.state).toBe("degraded");
        expect(status.failed).toBe(1);
        expect(status.lastError).toBeString();
        expect(status.lastError).not.toContain("private/failure.md");
    });

    test("reports complete coverage for a vault with zero expected notes", async () => {
        const runtime = await createRuntime(
            new InventoryBackend({}),
            new StatusQueue(),
            new FakeInventory("nomic-embed-text", []),
        );

        await runtime.reconcileRag();
        const status = await runtime.getRagStatus();

        expect(status).toMatchObject({
            enabled: true,
            state: "ready",
            expected: 0,
            indexed: 0,
            coverage: 1,
        });
    });
});

class StatusQueue {
    readonly jobs: RagIndexJob[] = [];
    currentStats: RagQueueStats = { queued: 0, active: 0, retrying: 0, failed: 0, oldestQueuedAt: null };

    async enqueue(job: RagIndexJob) { this.jobs.push(job); }
    async stats(_vaultId?: string) { return this.currentStats; }
}

class FakeInventory {
    listCalls = 0;
    beforeList?: () => Promise<void>;

    constructor(readonly model: string, readonly documents: VectorDocumentState[]) {}

    async listDocuments(_vaultId: string): Promise<VectorDocumentState[]> {
        this.listCalls += 1;
        await this.beforeList?.();
        return this.documents;
    }

    async countDocuments(_vaultId: string): Promise<number> {
        return this.documents.length;
    }
}

class InventoryBackend implements VaultBackend {
    readonly notes = new Map<string, string>();

    constructor(notes: Record<string, string>) {
        for (const [path, content] of Object.entries(notes)) this.notes.set(path, content);
    }

    async init() {}
    async close() {}
    async readNote(path: string) { return this.notes.get(path) ?? null; }
    async writeNote(path: string, content: string) { this.notes.set(path, content); return true; }
    async deleteNote(path: string) { return this.notes.delete(path); }
    async moveNote() { return false; }
    async getMetadata(path: string): Promise<NoteInfo | null> {
        const content = this.notes.get(path);
        return content === undefined
            ? null
            : { path, size: content.length, ctime: 10, mtime: 10, frontmatter: {}, tags: [], links: [] };
    }
    async listNotes() { return [...this.notes.keys()]; }
    async listNotesWithMtime() { return [...this.notes.keys()].map((path) => ({ path, mtime: 10 })); }
}

async function createRuntime(
    backend: InventoryBackend,
    ragQueue: StatusQueue,
    ragInventory: FakeInventory,
    ragApply: (vaultId: string, path: string, content: string | null, mtime?: number) => Promise<void> = async () => undefined,
): Promise<VaultRuntime> {
    const dataDir = await mkdtemp(join(tmpdir(), "couchloom-reconcile-test-"));
    temporaryDirectories.push(dataDir);
    return new VaultRuntime(
        { id: "personal", name: "Personal", mode: "local", path: dataDir },
        dataDir,
        false,
        { backend, ragQueue, ragInventory, ragApply },
    );
}

function document(path: string, contentHash: string, embeddingModel: string): VectorDocumentState {
    return { path, contentHash, mtime: 10, embeddingModel, updatedAt: "2026-10-13T00:00:00.000Z" };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
