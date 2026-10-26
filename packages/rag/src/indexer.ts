import { createHash } from "node:crypto";
import { chunkMarkdown, type ChunkOptions } from "./chunker.js";

export interface EmbeddingProvider {
    readonly dimensions: number;
    readonly model: string;
    embed(texts: string[]): Promise<number[][]>;
}

export interface VectorChunk {
    index: number;
    content: string;
    embedding: number[];
}

export interface VectorDocument {
    vaultId: string;
    path: string;
    mtime: number;
    contentHash: string;
    embeddingModel: string;
    chunks: VectorChunk[];
}

export interface VectorDocumentState {
    path: string;
    contentHash: string;
    mtime: number;
    embeddingModel: string;
    updatedAt: string;
}

export interface SemanticResult {
    vaultId: string;
    path: string;
    chunkIndex: number;
    content: string;
    score: number;
}

export interface VectorStore {
    getDocumentHash(vaultId: string, path: string): Promise<string | null>;
    getDocumentState(vaultId: string, path: string): Promise<VectorDocumentState | null>;
    replaceDocument(document: VectorDocument): Promise<void>;
    deleteDocument(vaultId: string, path: string): Promise<void>;
    listDocuments(vaultId: string): Promise<VectorDocumentState[]>;
    countDocuments(vaultId: string): Promise<number>;
    search(embedding: number[], vaultIds: string[], limit: number, folder?: string): Promise<SemanticResult[]>;
    close(): Promise<void>;
}

export function hashDocumentContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}

export interface DocumentChange {
    vaultId: string;
    path: string;
    content: string | null;
    mtime?: number;
}

export class RagIndexer {
    constructor(
        private readonly store: VectorStore,
        private readonly embeddings: EmbeddingProvider,
        private readonly chunkOptions: ChunkOptions = { maxChars: 1800, overlapChars: 200 },
    ) {}

    async apply(change: DocumentChange): Promise<"indexed" | "unchanged" | "deleted"> {
        if (change.content === null) {
            await this.store.deleteDocument(change.vaultId, change.path);
            return "deleted";
        }
        const contentHash = hashDocumentContent(change.content);
        const existing = await this.store.getDocumentState(change.vaultId, change.path);
        if (existing?.contentHash === contentHash && existing.embeddingModel === this.embeddings.model) return "unchanged";
        const chunks = chunkMarkdown(change.content, this.chunkOptions);
        const vectors = await this.embeddings.embed(chunks.map(({ content }) => content));
        if (vectors.length !== chunks.length || vectors.some((vector) => vector.length !== this.embeddings.dimensions)) {
            throw new Error(`Embedding response does not match ${this.embeddings.dimensions} dimensions`);
        }
        await this.store.replaceDocument({
            vaultId: change.vaultId,
            path: change.path,
            mtime: change.mtime ?? Date.now(),
            contentHash,
            embeddingModel: this.embeddings.model,
            chunks: chunks.map((chunk, index) => ({ ...chunk, embedding: vectors[index] })),
        });
        return "indexed";
    }

    async search(query: string, vaultIds: string[], limit = 8, folder?: string): Promise<SemanticResult[]> {
        const [embedding] = await this.embeddings.embed([query]);
        if (!embedding || embedding.length !== this.embeddings.dimensions) throw new Error("Invalid query embedding dimensions");
        return this.store.search(embedding, vaultIds, Math.max(1, Math.min(limit, 50)), folder);
    }
}
