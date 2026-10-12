import { expect, test } from "bun:test";
import { RagIndexer, type EmbeddingProvider, type VectorStore, type VectorDocument } from "../../src/indexer.js";

class MemoryStore implements VectorStore {
    hashes = new Map<string, string>();
    documents: VectorDocument[] = [];
    deletes: string[] = [];
    async getDocumentHash(vaultId: string, path: string) { return this.hashes.get(`${vaultId}:${path}`) ?? null; }
    async getDocumentState(vaultId: string, path: string) {
        const hash = this.hashes.get(`${vaultId}:${path}`);
        return hash ? { path, contentHash: hash, mtime: 1, embeddingModel: "test", updatedAt: new Date(0).toISOString() } : null;
    }
    async replaceDocument(document: VectorDocument) { this.documents.push(document); this.hashes.set(`${document.vaultId}:${document.path}`, document.contentHash); }
    async deleteDocument(vaultId: string, path: string) { this.deletes.push(`${vaultId}:${path}`); this.hashes.delete(`${vaultId}:${path}`); }
    async listDocuments() { return []; }
    async countDocuments() { return this.documents.length; }
    async search() { return []; }
    async close() {}
}

test("skips unchanged documents and routes deletes", async () => {
    const store = new MemoryStore();
    let embeddingCalls = 0;
    const embeddings: EmbeddingProvider = { dimensions: 2, model: "test", async embed(texts) { embeddingCalls++; return texts.map(() => [1, 0]); } };
    const indexer = new RagIndexer(store, embeddings, { maxChars: 50, overlapChars: 5 });

    expect(await indexer.apply({ vaultId: "personal", path: "a.md", content: "hello", mtime: 1 })).toBe("indexed");
    expect(await indexer.apply({ vaultId: "personal", path: "a.md", content: "hello", mtime: 2 })).toBe("unchanged");
    expect(embeddingCalls).toBe(1);
    expect(store.documents[0].chunks[0].embedding).toEqual([1, 0]);
    expect(await indexer.apply({ vaultId: "personal", path: "a.md", content: null })).toBe("deleted");
    expect(store.deletes).toEqual(["personal:a.md"]);
});

test("re-embeds unchanged content when the stored model differs", async () => {
    const store = new MemoryStore();
    store.hashes.set("personal:a.md", "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    store.getDocumentState = async (_vaultId: string, path: string) => ({
        path,
        contentHash: store.hashes.get("personal:a.md")!,
        mtime: 1,
        embeddingModel: "old-model",
        updatedAt: new Date(0).toISOString(),
    });
    let embeddingCalls = 0;
    const embeddings: EmbeddingProvider = {
        dimensions: 2,
        model: "new-model",
        async embed(texts) {
            embeddingCalls += 1;
            return texts.map(() => [1, 0]);
        },
    };
    const indexer = new RagIndexer(store, embeddings);

    expect(await indexer.apply({ vaultId: "personal", path: "a.md", content: "hello", mtime: 2 })).toBe("indexed");
    expect(embeddingCalls).toBe(1);
    expect(store.documents.at(-1)?.embeddingModel).toBe("new-model");
});
