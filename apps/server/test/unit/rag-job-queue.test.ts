import { describe, expect, test } from "bun:test";
import {
    RAG_DEAD_LETTER_QUEUE,
    RAG_INDEX_QUEUE,
    RagJobQueue,
    type PgBossJob,
    type PgBossLike,
    type RagIndexJob,
} from "../../src/rag-job-queue.js";

type StoredJob = PgBossJob<RagIndexJob>;

class FakeBoss implements PgBossLike {
    readonly queues: Array<{ name: string; options?: Record<string, unknown> }> = [];
    readonly queueUpdates: Array<{ name: string; options: Record<string, unknown> }> = [];
    readonly upserts: Array<{ name: string; data: RagIndexJob; options: Record<string, unknown> }> = [];
    readonly jobs = new Map<string, StoredJob[]>();
    readonly errorListeners: Array<(error: unknown) => void> = [];
    redriven = 0;
    stopped = false;
    worker?: (jobs: StoredJob[]) => Promise<void>;

    async start() {}

    on(event: string, listener: (error: unknown) => void) {
        if (event === "error") this.errorListeners.push(listener);
        return this;
    }

    async createQueue(name: string, options?: Record<string, unknown>) {
        this.queues.push({ name, options });
        this.jobs.set(name, this.jobs.get(name) ?? []);
    }

    async updateQueue(name: string, options: Record<string, unknown>) {
        this.queueUpdates.push({ name, options });
    }

    async upsert(name: string, data: RagIndexJob, options: Record<string, unknown>) {
        this.upserts.push({ name, data, options });
        const queue = this.jobs.get(name) ?? [];
        const existing = queue.find(
            (job) => (job.state === "created" || job.state === "retry") && job.singletonKey === options.singletonKey,
        );
        if (existing) {
            existing.data = data;
            return { jobs: [existing.id], updated: 1, inserted: 0 };
        }
        queue.push({
            id: `job-${queue.length + 1}`,
            data,
            state: "created",
            singletonKey: String(options.singletonKey),
            createdOn: new Date("2026-10-13T00:00:00.000Z"),
        });
        this.jobs.set(name, queue);
        return { jobs: [queue.at(-1)!.id], updated: 0, inserted: 1 };
    }

    async work(
        _name: string,
        _options: Record<string, unknown>,
        handler: (jobs: StoredJob[]) => Promise<void>,
    ) {
        this.worker = handler;
        return "worker-1";
    }

    async findJobs(name: string, options: { data?: Partial<RagIndexJob> } = {}) {
        return (this.jobs.get(name) ?? []).filter((job) =>
            Object.entries(options.data ?? {}).every(([key, value]) => job.data[key as keyof RagIndexJob] === value),
        );
    }

    async redrive(name: string, options?: Record<string, unknown>) {
        expect(name).toBe(RAG_DEAD_LETTER_QUEUE);
        expect(options).toEqual({ sourceName: RAG_INDEX_QUEUE });
        return this.redriven;
    }

    async stop() {
        this.stopped = true;
    }
}

describe("RagJobQueue", () => {
    test("creates queues with bounded retry, heartbeat, and dead-letter policy", async () => {
        const boss = new FakeBoss();
        const queue = new RagJobQueue("postgres://unused", { boss });

        expect(boss.errorListeners).toHaveLength(1);

        await queue.start();

        expect(boss.queues).toEqual([
            { name: RAG_DEAD_LETTER_QUEUE, options: undefined },
            {
                name: RAG_INDEX_QUEUE,
                options: {
                    policy: "standard",
                    retryLimit: 10,
                    retryDelay: 1,
                    retryBackoff: true,
                    retryDelayMax: 900,
                    heartbeatSeconds: 30,
                    expireInSeconds: 3600,
                    deadLetter: RAG_DEAD_LETTER_QUEUE,
                },
            },
        ]);
        expect(boss.queueUpdates).toEqual([
            {
                name: RAG_INDEX_QUEUE,
                options: {
                    retryLimit: 10,
                    retryDelay: 1,
                    retryBackoff: true,
                    retryDelayMax: 900,
                    heartbeatSeconds: 30,
                    expireInSeconds: 3600,
                    deadLetter: RAG_DEAD_LETTER_QUEUE,
                },
            },
        ]);
    });

    test("upserts the latest pending event with the full safety policy", async () => {
        const boss = new FakeBoss();
        const queue = new RagJobQueue("postgres://unused", { boss });
        await queue.start();

        await queue.enqueue({ vaultId: "personal", path: "notes/a.md", observedMtime: 1 });
        await queue.enqueue({ vaultId: "personal", path: "notes/a.md", observedMtime: 2 });

        expect(boss.upserts.at(-1)).toEqual({
            name: RAG_INDEX_QUEUE,
            data: { vaultId: "personal", path: "notes/a.md", observedMtime: 2 },
            options: {
                singletonKey: "personal:notes/a.md",
                retryLimit: 10,
                retryDelay: 1,
                retryBackoff: true,
                retryDelayMax: 900,
                heartbeatSeconds: 30,
                expireInSeconds: 3600,
                deadLetter: RAG_DEAD_LETTER_QUEUE,
            },
        });
        expect(boss.jobs.get(RAG_INDEX_QUEUE)).toHaveLength(1);
        expect(boss.jobs.get(RAG_INDEX_QUEUE)?.[0]?.data.observedMtime).toBe(2);
    });

    test("keeps later work queued when an edit arrives for an active job", async () => {
        const boss = new FakeBoss();
        const queue = new RagJobQueue("postgres://unused", { boss });
        await queue.start();
        await queue.enqueue({ vaultId: "personal", path: "notes/a.md", observedMtime: 1 });
        boss.jobs.get(RAG_INDEX_QUEUE)![0]!.state = "active";

        await queue.enqueue({ vaultId: "personal", path: "notes/a.md", observedMtime: 2 });

        expect(boss.jobs.get(RAG_INDEX_QUEUE)?.map((job) => [job.state, job.data.observedMtime])).toEqual([
            ["active", 1],
            ["created", 2],
        ]);
    });

    test("maps global and vault-filtered job states without returning paths", async () => {
        const boss = new FakeBoss();
        const queue = new RagJobQueue("postgres://unused", { boss });
        await queue.start();
        boss.jobs.set(RAG_INDEX_QUEUE, [
            {
                id: "queued",
                data: { vaultId: "personal", path: "secret/a.md" },
                state: "created",
                singletonKey: "personal:secret/a.md",
                createdOn: new Date("2026-10-13T01:00:00.000Z"),
            },
            {
                id: "retry",
                data: { vaultId: "work", path: "secret/b.md" },
                state: "retry",
                singletonKey: "work:secret/b.md",
                createdOn: new Date("2026-10-13T00:00:00.000Z"),
            },
            {
                id: "active",
                data: { vaultId: "personal", path: "secret/c.md" },
                state: "active",
                singletonKey: "personal:secret/c.md",
                createdOn: new Date("2026-10-13T02:00:00.000Z"),
            },
        ]);
        boss.jobs.set(RAG_DEAD_LETTER_QUEUE, [
            {
                id: "failed",
                data: { vaultId: "personal", path: "secret/d.md" },
                state: "created",
                singletonKey: "personal:secret/d.md",
                createdOn: new Date("2026-10-13T03:00:00.000Z"),
            },
        ]);

        expect(await queue.stats()).toEqual({
            queued: 1,
            active: 1,
            retrying: 1,
            failed: 1,
            oldestQueuedAt: "2026-10-13T00:00:00.000Z",
        });
        const personal = await queue.stats("personal");
        expect(personal).toEqual({
            queued: 1,
            active: 1,
            retrying: 0,
            failed: 1,
            oldestQueuedAt: "2026-10-13T01:00:00.000Z",
        });
        expect(JSON.stringify(personal)).not.toContain("secret/");
    });

    test("runs one job at a time, redrives the RAG dead-letter queue, and closes", async () => {
        const boss = new FakeBoss();
        boss.redriven = 3;
        const queue = new RagJobQueue("postgres://unused", { boss, concurrency: 1 });
        await queue.start();
        const handled: RagIndexJob[] = [];

        await queue.work(async (job) => {
            handled.push(job);
        });
        await boss.worker?.([
            {
                id: "work-1",
                data: { vaultId: "personal", path: "notes/a.md" },
                state: "active",
                singletonKey: "personal:notes/a.md",
                createdOn: new Date(),
            },
        ]);

        expect(handled).toEqual([{ vaultId: "personal", path: "notes/a.md" }]);
        expect(await queue.redrive()).toBe(3);
        await queue.close();
        expect(boss.stopped).toBe(true);
    });

    test("reports only failures that pg-boss will retry", async () => {
        const boss = new FakeBoss();
        const queue = new RagJobQueue("postgres://unused", { boss, retryLimit: 1 });
        const retriedVaults: string[] = [];
        await queue.start();
        await queue.work(
            async () => { throw new Error("embedding unavailable"); },
            (vaultId) => retriedVaults.push(vaultId),
        );

        const job = (retryCount: number): StoredJob => ({
            id: `attempt-${retryCount}`,
            data: { vaultId: "personal", path: "notes/a.md" },
            state: "active",
            singletonKey: "personal:notes/a.md",
            createdOn: new Date(),
            retryCount,
        });
        await expect(boss.worker?.([job(0)])).rejects.toThrow("embedding unavailable");
        await expect(boss.worker?.([job(1)])).rejects.toThrow("embedding unavailable");

        expect(retriedVaults).toEqual(["personal"]);
    });
});
