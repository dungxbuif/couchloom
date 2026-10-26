import postgres, { type Sql } from "postgres";
import type { SemanticResult, VectorDocument, VectorDocumentState, VectorStore } from "./indexer.js";

function vector(values: number[]): string {
    if (!values.every(Number.isFinite)) throw new Error("Vector contains a non-finite value");
    return `[${values.join(",")}]`;
}

export class PgVectorStore implements VectorStore {
    readonly #sql: Sql;
    readonly #dimensions: number;

    constructor(databaseUrl: string, dimensions: number) {
        if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 16000) throw new Error("Invalid embedding dimensions");
        this.#dimensions = dimensions;
        this.#sql = postgres(databaseUrl, { max: 10, idle_timeout: 20 });
    }

    async migrate(): Promise<void> {
        await this.#sql`CREATE EXTENSION IF NOT EXISTS vector`;
        await this.#sql`
            CREATE TABLE IF NOT EXISTS rag_documents (
                vault_id text NOT NULL,
                path text NOT NULL,
                content_hash text NOT NULL,
                mtime double precision NOT NULL,
                embedding_model text NOT NULL,
                updated_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (vault_id, path)
            )`;
        await this.#sql.unsafe(`
            CREATE TABLE IF NOT EXISTS rag_chunks (
                vault_id text NOT NULL,
                path text NOT NULL,
                chunk_index integer NOT NULL,
                content text NOT NULL,
                embedding vector(${this.#dimensions}) NOT NULL,
                PRIMARY KEY (vault_id, path, chunk_index),
                FOREIGN KEY (vault_id, path) REFERENCES rag_documents(vault_id, path) ON DELETE CASCADE
            )`);
        await this.#sql`CREATE INDEX IF NOT EXISTS rag_chunks_vault_path_idx ON rag_chunks (vault_id, path)`;
        await this.#sql`CREATE INDEX IF NOT EXISTS rag_documents_vault_updated_idx ON rag_documents (vault_id, updated_at)`;
    }

    async getDocumentHash(vaultId: string, path: string): Promise<string | null> {
        const rows = await this.#sql<{ content_hash: string }[]>`SELECT content_hash FROM rag_documents WHERE vault_id = ${vaultId} AND path = ${path}`;
        return rows[0]?.content_hash ?? null;
    }

    async getDocumentState(vaultId: string, path: string): Promise<VectorDocumentState | null> {
        const rows = await this.#sql<Array<{
            path: string;
            content_hash: string;
            mtime: number;
            embedding_model: string;
            updated_at: Date;
        }>>`
            SELECT path, content_hash, mtime, embedding_model, updated_at
            FROM rag_documents
            WHERE vault_id = ${vaultId} AND path = ${path}`;
        const row = rows[0];
        return row ? mapDocumentState(row) : null;
    }

    async replaceDocument(document: VectorDocument): Promise<void> {
        await this.#sql.begin(async (sql) => {
            await sql`DELETE FROM rag_documents WHERE vault_id = ${document.vaultId} AND path = ${document.path}`;
            await sql`INSERT INTO rag_documents (vault_id, path, content_hash, mtime, embedding_model) VALUES (${document.vaultId}, ${document.path}, ${document.contentHash}, ${document.mtime}, ${document.embeddingModel})`;
            for (const chunk of document.chunks) {
                await sql`INSERT INTO rag_chunks (vault_id, path, chunk_index, content, embedding) VALUES (${document.vaultId}, ${document.path}, ${chunk.index}, ${chunk.content}, ${vector(chunk.embedding)}::vector)`;
            }
        });
    }

    async deleteDocument(vaultId: string, path: string): Promise<void> {
        await this.#sql`DELETE FROM rag_documents WHERE vault_id = ${vaultId} AND path = ${path}`;
    }

    async listDocuments(vaultId: string): Promise<VectorDocumentState[]> {
        const rows = await this.#sql<Array<{
            path: string;
            content_hash: string;
            mtime: number;
            embedding_model: string;
            updated_at: Date;
        }>>`
            SELECT path, content_hash, mtime, embedding_model, updated_at
            FROM rag_documents
            WHERE vault_id = ${vaultId}
            ORDER BY path`;
        return rows.map(mapDocumentState);
    }

    async countDocuments(vaultId: string): Promise<number> {
        const rows = await this.#sql<Array<{ count: string }>>`
            SELECT count(*)::text AS count
            FROM rag_documents
            WHERE vault_id = ${vaultId}`;
        return Number(rows[0]?.count ?? 0);
    }

    async search(embedding: number[], vaultIds: string[], limit: number): Promise<SemanticResult[]> {
        if (embedding.length !== this.#dimensions) throw new Error("Search vector dimensions do not match store");
        const rows = await this.#sql<Array<{ vault_id: string; path: string; chunk_index: number; content: string; score: number }>>`
            WITH ranked AS (
                SELECT vault_id, path, chunk_index, content,
                    1 - (embedding <=> ${vector(embedding)}::vector) AS score,
                    row_number() OVER (
                        PARTITION BY vault_id, path
                        ORDER BY embedding <=> ${vector(embedding)}::vector, chunk_index
                    ) AS path_rank
                FROM rag_chunks
                WHERE vault_id = ANY(${this.#sql.array(vaultIds)})
            )
            SELECT vault_id, path, chunk_index, content, score
            FROM ranked
            WHERE path_rank = 1
            ORDER BY score DESC, vault_id, path
            LIMIT ${limit}`;
        return rows.map((row) => ({ vaultId: row.vault_id, path: row.path, chunkIndex: row.chunk_index, content: row.content, score: Number(row.score) }));
    }

    async close(): Promise<void> {
        await this.#sql.end({ timeout: 5 });
    }
}

function mapDocumentState(row: {
    path: string;
    content_hash: string;
    mtime: number;
    embedding_model: string;
    updated_at: Date;
}): VectorDocumentState {
    return {
        path: row.path,
        contentHash: row.content_hash,
        mtime: Number(row.mtime),
        embeddingModel: row.embedding_model,
        updatedAt: row.updated_at.toISOString(),
    };
}
