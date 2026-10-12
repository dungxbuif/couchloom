import { afterAll, beforeAll, expect, test } from "bun:test";
import { PgBoss } from "pg-boss";
import {
    RAG_DEAD_LETTER_QUEUE,
    RAG_INDEX_QUEUE,
    RagJobQueue,
    type RagIndexJob,
} from "../../src/rag-job-queue.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? test : test.skip;

beforeAll(async () => {
    if (!databaseUrl) return;
    await clearQueues(databaseUrl);
});

afterAll(async () => {
    if (!databaseUrl) return;
    await clearQueues(databaseUrl);
});

run(
    "persists work across restart and recovers a dead-lettered job",
    async () => {
        const first = new RagJobQueue(databaseUrl!, testOptions());
        await first.start();
        await first.enqueue({ vaultId: "integration", path: "durable.md", observedMtime: 1 });
        await first.close();

        const second = new RagJobQueue(databaseUrl!, testOptions());
        await second.start();
        const durable = deferred<RagIndexJob>();
        await second.work(async (job) => durable.resolve(job));
        expect(await withTimeout(durable.promise, 15_000)).toEqual({
            vaultId: "integration",
            path: "durable.md",
            observedMtime: 1,
        });
        await second.close();

        const failing = new RagJobQueue(databaseUrl!, testOptions());
        await failing.start();
        let attempts = 0;
        await failing.work(async () => {
            attempts += 1;
            throw new Error("intentional integration failure");
        });
        await failing.enqueue({ vaultId: "integration", path: "redrive.md", observedMtime: 2 });
        await waitFor(async () => (await failing.stats("integration")).failed === 1, 20_000);
        expect(attempts).toBe(2);
        await failing.close();

        const recovered = new RagJobQueue(databaseUrl!, testOptions());
        await recovered.start();
        const redriven = deferred<RagIndexJob>();
        await recovered.work(async (job) => redriven.resolve(job));
        expect(await recovered.redrive()).toBe(1);
        expect(await withTimeout(redriven.promise, 15_000)).toEqual({
            vaultId: "integration",
            path: "redrive.md",
            observedMtime: 2,
        });
        await recovered.close();
    },
    45_000,
);

function testOptions() {
    return {
        retryLimit: 1,
        retryDelaySeconds: 1,
        retryDelayMaxSeconds: 1,
        heartbeatSeconds: 10,
        shutdownGraceMs: 5_000,
    };
}

async function clearQueues(url: string): Promise<void> {
    const boss = new PgBoss(url);
    await boss.start();
    await boss.createQueue(RAG_DEAD_LETTER_QUEUE);
    await boss.createQueue(RAG_INDEX_QUEUE);
    await boss.deleteAllJobs(RAG_INDEX_QUEUE);
    await boss.deleteAllJobs(RAG_DEAD_LETTER_QUEUE);
    await boss.stop({ graceful: true, timeout: 5_000 });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await Bun.sleep(100);
    }
    throw new Error(`condition not met within ${timeoutMs}ms`);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
        promise,
        Bun.sleep(timeoutMs).then(() => {
            throw new Error(`operation timed out after ${timeoutMs}ms`);
        }),
    ]);
}
