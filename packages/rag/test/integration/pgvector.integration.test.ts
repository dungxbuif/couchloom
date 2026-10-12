import { afterAll, beforeAll, expect, test } from "bun:test";
import { PgVectorStore } from "../../src/pgvector-store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? test : test.skip;
let store: PgVectorStore;

beforeAll(async () => {
    if (!databaseUrl) return;
    store = new PgVectorStore(databaseUrl, 3);
    await store.migrate();
    await store.deleteDocument("integration-a", "note.md");
    await store.deleteDocument("integration-b", "note.md");
});

afterAll(async () => {
    if (!store) return;
    await store.deleteDocument("integration-a", "note.md");
    await store.deleteDocument("integration-b", "note.md");
    await store.close();
});

run("persists, isolates, searches, and deletes vectors", async () => {
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
