import { OpenAICompatibleEmbeddings, PgVectorStore, RagIndexer, type SemanticResult, type VectorDocumentState } from "@couchloom/rag";

type Environment = Record<string, string | undefined>;

export class RagRuntime {
    readonly #store: PgVectorStore;
    readonly #indexer: RagIndexer;
    readonly model: string;

    private constructor(store: PgVectorStore, indexer: RagIndexer, model: string) {
        this.#store = store;
        this.#indexer = indexer;
        this.model = model;
    }

    static fromEnvironment(env: Environment = process.env): RagRuntime | null {
        if (!env.DATABASE_URL) return null;
        const required = ["EMBEDDING_BASE_URL", "EMBEDDING_MODEL", "EMBEDDING_DIMENSIONS"] as const;
        for (const key of required) if (!env[key]) throw new Error(`${key} is required when DATABASE_URL is set`);
        const dimensions = Number(env.EMBEDDING_DIMENSIONS);
        if (!Number.isInteger(dimensions) || dimensions < 1) throw new Error("EMBEDDING_DIMENSIONS must be a positive integer");
        const maxChars = Number(env.RAG_CHUNK_CHARS ?? 1800);
        const overlapChars = Number(env.RAG_CHUNK_OVERLAP ?? 200);
        const embeddings = new OpenAICompatibleEmbeddings({
            baseUrl: env.EMBEDDING_BASE_URL!,
            apiKey: env.EMBEDDING_API_KEY,
            model: env.EMBEDDING_MODEL!,
            dimensions,
        });
        const store = new PgVectorStore(env.DATABASE_URL, dimensions);
        return new RagRuntime(store, new RagIndexer(store, embeddings, { maxChars, overlapChars }), env.EMBEDDING_MODEL!);
    }

    async start(): Promise<void> {
        await this.#store.migrate();
    }

    apply(vaultId: string, path: string, content: string | null, mtime?: number) {
        return this.#indexer.apply({ vaultId, path, content, mtime });
    }

    search(query: string, vaultIds: string[], limit?: number, folder?: string): Promise<SemanticResult[]> {
        return this.#indexer.search(query, vaultIds, limit, folder);
    }

    listDocuments(vaultId: string): Promise<VectorDocumentState[]> {
        return this.#store.listDocuments(vaultId);
    }

    countDocuments(vaultId: string): Promise<number> {
        return this.#store.countDocuments(vaultId);
    }

    close(): Promise<void> {
        return this.#store.close();
    }
}
