import { expect, test } from "bun:test";
import { RagIndexer, type EmbeddingProvider, type VectorStore, type VectorDocument } from "./indexer.js";

class MemoryStore implements VectorStore {
    hashes = new Map<string, string>();
    documents: VectorDocument[] = [];
    deletes: string[] = [];
    async getDocumentHash(vaultId: string, path: string) { return this.hashes.get(`${vaultId}:${path}`) ?? null; }
    async replaceDocument(document: VectorDocument) { this.documents.push(document); this.hashes.set(`${document.vaultId}:${document.path}`, document.contentHash); }
    async deleteDocument(vaultId: string, path: string) { this.deletes.push(`${vaultId}:${path}`); this.hashes.delete(`${vaultId}:${path}`); }
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
