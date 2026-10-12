import { afterEach, describe, expect, test } from "bun:test";
import type { NoteInfo, VaultBackend, VaultChangeCallback } from "@couchloom/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RagIndexJob } from "../../src/rag-job-queue.js";
import { VaultRuntime } from "../../src/vault-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("VaultRuntime durable RAG jobs", () => {
    test("catch-up waits for durable enqueue before its checkpoint advances", async () => {
        const backend = new FakeBackend();
        backend.notes.set("note.md", "latest");
        const enqueueGate = deferred<void>();
        const queue = new FakeQueue(async () => enqueueGate.promise);
        const runtime = await createRuntime(backend, queue);

        const starting = runtime.start();
        await waitFor(() => queue.jobs.length === 1);

        expect(queue.jobs).toEqual([{ vaultId: "personal", path: "note.md", observedMtime: 10 }]);
        expect(backend.savedCheckpoint).toBeNull();

        enqueueGate.resolve();
        await starting;
        expect(backend.savedCheckpoint).toBe("1");
        expect(runtime.searchIndex.since).toBe("1");
    });

    test("queue failure prevents checkpoint advancement", async () => {
        const backend = new FakeBackend();
        backend.notes.set("note.md", "latest");
        const queue = new FakeQueue(async () => {
            throw new Error("postgres unavailable");
        });
        const runtime = await createRuntime(backend, queue);

        await expect(runtime.start()).rejects.toThrow("postgres unavailable");

        expect(backend.savedCheckpoint).toBeNull();
        expect(runtime.searchIndex.since).toBe("");
    });

    test("worker rereads current content and routes missing notes to delete", async () => {
        const backend = new FakeBackend();
        backend.notes.set("note.md", "newer than queued payload");
        backend.mtimes.set("note.md", 22);
        const applied: Array<[string, string, string | null, number | undefined]> = [];
        const runtime = await createRuntime(backend, new FakeQueue(), async (vaultId, path, content, mtime) => {
            applied.push([vaultId, path, content, mtime]);
        });

        await runtime.processRagJob("note.md");
        backend.notes.delete("note.md");
        backend.mtimes.delete("note.md");
        await runtime.processRagJob("note.md");

        expect(applied).toEqual([
            ["personal", "note.md", "newer than queued payload", 22],
            ["personal", "note.md", null, undefined],
        ]);
    });

    test("a newer edit can enqueue while the same note is actively processing", async () => {
        const backend = new FakeBackend();
        backend.notes.set("note.md", "current");
        const applyGate = deferred<void>();
        const queue = new FakeQueue();
        const runtime = await createRuntime(backend, queue, async () => applyGate.promise);

        const active = runtime.processRagJob("note.md");
        await Bun.sleep(0);
        await runtime.enqueueRag("note.md", 30);

        expect(queue.jobs).toEqual([{ vaultId: "personal", path: "note.md", observedMtime: 30 }]);
        applyGate.resolve();
        await active;
    });

    test("metadata stays readable when RAG processing fails", async () => {
        const backend = new FakeBackend();
        backend.notes.set("note.md", "# Metadata survives");
        const runtime = await createRuntime(backend, new FakeQueue(), async () => {
            throw new Error("ollama unavailable");
        });
        await runtime.start();

        await expect(runtime.processRagJob("note.md")).rejects.toThrow("ollama unavailable");

        expect(await runtime.context.backend.readNote("note.md")).toBe("# Metadata survives");
        expect(runtime.context.searchIndex.listPaths()).toEqual(["note.md"]);
    });
});

class FakeQueue {
    readonly jobs: RagIndexJob[] = [];

    constructor(readonly onEnqueue: (job: RagIndexJob) => Promise<void> = async () => undefined) {}

    async enqueue(job: RagIndexJob): Promise<void> {
        this.jobs.push(job);
        await this.onEnqueue(job);
    }
}

class FakeBackend implements VaultBackend {
    readonly notes = new Map<string, string>();
    readonly mtimes = new Map<string, number>();
    savedCheckpoint: string | null = null;
    watchCallback?: VaultChangeCallback;

    async init() {}
    async close() {}
    async readNote(path: string) { return this.notes.get(path) ?? null; }
    async writeNote(path: string, content: string) { this.notes.set(path, content); return true; }
    async deleteNote(path: string) { return this.notes.delete(path); }
    async moveNote(from: string, to: string) {
        const content = this.notes.get(from);
        if (content === undefined) return false;
        this.notes.delete(from);
        this.notes.set(to, content);
        return true;
    }
    async getMetadata(path: string): Promise<NoteInfo | null> {
        const content = this.notes.get(path);
        if (content === undefined) return null;
        const mtime = this.mtimes.get(path) ?? 10;
        return { path, size: content.length, ctime: mtime, mtime, frontmatter: {}, tags: [], links: [] };
    }
    async listNotes() { return [...this.notes.keys()]; }
    async listNotesWithMtime() {
        return [...this.notes.keys()].map((path) => ({ path, mtime: this.mtimes.get(path) ?? 10 }));
    }
    async catchUp(_since: string, callback: VaultChangeCallback, onBatch?: (since: string, processed: number) => Promise<void>) {
        for (const [path, content] of this.notes) await callback(path, content, this.mtimes.get(path) ?? 10, "1");
        await onBatch?.("1", this.notes.size);
        this.savedCheckpoint = "1";
        return "1";
    }
    async watchChanges(callback: VaultChangeCallback) {
        this.watchCallback = callback;
    }
}

async function createRuntime(
    backend: FakeBackend,
    queue: FakeQueue,
    ragApply: (vaultId: string, path: string, content: string | null, mtime?: number) => Promise<void> = async () => undefined,
): Promise<VaultRuntime> {
    const dataDir = await mkdtemp(join(tmpdir(), "couchloom-runtime-test-"));
    temporaryDirectories.push(dataDir);
    return new VaultRuntime(
        {
            id: "personal",
            name: "Personal",
            mode: "couchdb",
            url: "http://unused",
            database: "unused",
            user: "unused",
            password: "unused",
        },
        dataDir,
        false,
        { backend, ragQueue: queue, ragApply },
    );
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await Bun.sleep(5);
    }
    throw new Error(`condition not met within ${timeoutMs}ms`);
}
