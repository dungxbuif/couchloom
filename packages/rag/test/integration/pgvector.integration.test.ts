import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import postgres from "postgres";
import { PgVectorStore } from "../../src/pgvector-store.js";

const execFileAsync = promisify(execFile);
let databaseUrl = process.env.TEST_DATABASE_URL;
let containerName: string | null = null;
let store: PgVectorStore;
let storeReady = false;

beforeAll(async () => {
    if (!databaseUrl) {
        const port = await freePort();
        containerName = `couchloom-pgvector-test-${process.pid}-${Date.now()}`;
        await docker(
            "run", "-d", "--name", containerName,
            "-e", "POSTGRES_USER=test",
            "-e", "POSTGRES_PASSWORD=test",
            "-e", "POSTGRES_DB=test",
            "-p", `127.0.0.1:${port}:5432`,
            "pgvector/pgvector:0.8.6-pg17-bookworm",
        );
        databaseUrl = `postgres://test:test@127.0.0.1:${port}/test`;
        await waitFor(async () => {
            try {
                await docker("exec", containerName!, "pg_isready", "-U", "test", "-d", "test");
                return true;
            } catch {
                return false;
            }
        }, 30_000);
        await waitFor(async () => {
            const probe = postgres(databaseUrl!, { max: 1, connect_timeout: 1 });
            try {
                const rows = await probe<Array<{ ok: number }>>`SELECT 1::int AS ok`;
                return rows[0]?.ok === 1;
            } catch {
                return false;
            } finally {
                await probe.end({ timeout: 1 }).catch(() => undefined);
            }
        }, 30_000);
    }
    store = new PgVectorStore(databaseUrl, 3);
    await store.migrate();
    storeReady = true;
    await store.deleteDocument("integration-a", "note.md");
    await store.deleteDocument("integration-b", "note.md");
}, 60_000);

afterAll(async () => {
    if (storeReady) {
        await store.deleteDocument("integration-a", "note.md");
        await store.deleteDocument("integration-b", "note.md");
    }
    if (store) {
        await store.close();
    }
    if (containerName) await docker("rm", "-f", containerName).catch(() => undefined);
});

test("persists, isolates, searches, and deletes vectors", async () => {
    await store.replaceDocument({ vaultId: "integration-a", path: "note.md", mtime: 1, contentHash: "a", embeddingModel: "test", chunks: [{ index: 0, content: "alpha", embedding: [1, 0, 0] }] });
    await store.replaceDocument({ vaultId: "integration-b", path: "note.md", mtime: 1, contentHash: "b", embeddingModel: "test", chunks: [{ index: 0, content: "beta", embedding: [0, 1, 0] }] });
    expect(await store.getDocumentHash("integration-a", "note.md")).toBe("a");
    expect(await store.getDocumentState("integration-a", "note.md")).toEqual(
        expect.objectContaining({ path: "note.md", contentHash: "a", embeddingModel: "test" }),
    );
    expect(await store.countDocuments("integration-a")).toBe(1);
    expect(await store.listDocuments("integration-a")).toEqual([
        expect.objectContaining({
            path: "note.md",
            contentHash: "a",
            mtime: 1,
            embeddingModel: "test",
            updatedAt: expect.any(String),
        }),
    ]);
    expect(await store.listDocuments("integration-b")).toEqual([
        expect.objectContaining({ path: "note.md", contentHash: "b" }),
    ]);
    const results = await store.search([1, 0, 0], ["integration-a"], 5);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ vaultId: "integration-a", content: "alpha" });
    await store.deleteDocument("integration-a", "note.md");
    expect(await store.getDocumentHash("integration-a", "note.md")).toBeNull();
});

async function docker(...args: string[]): Promise<string> {
    const result = await execFileAsync("docker", args, { timeout: 60_000 });
    return result.stdout.trim();
}

async function freePort(): Promise<number> {
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = listener.port;
    listener.stop(true);
    return port;
}

async function waitFor(check: () => Promise<boolean>, timeout: number): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return;
        await Bun.sleep(100);
    }
    throw new Error("timed out waiting for disposable pgvector");
}
