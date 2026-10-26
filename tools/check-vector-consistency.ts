import postgres from "postgres";

// Read-only diagnostic: print similarity and identity, never note bodies or credentials.
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
try {
    const rows = await sql`SELECT path, chunk_index, content, embedding::text AS embedding
        FROM rag_chunks WHERE vault_id = 'personal' AND chunk_index = 0
        ORDER BY path LIMIT 5`;
    for (const row of rows) {
        const response = await fetch(`${process.env.EMBEDDING_BASE_URL}/embeddings`, {
            method: "POST",
            signal: AbortSignal.timeout(60000),
            headers: { "content-type": "application/json", authorization: `Bearer ${process.env.EMBEDDING_API_KEY}` },
            body: JSON.stringify({ model: process.env.EMBEDDING_MODEL, input: [row.content], dimensions: Number(process.env.EMBEDDING_DIMENSIONS) }),
        });
        if (!response.ok) throw new Error(`embedding HTTP ${response.status}`);
        const fresh = (await response.json()).data[0].embedding as number[];
        const stored = JSON.parse(row.embedding) as number[];
        const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x*x, 0));
        const cosine = fresh.reduce((s, x, i) => s + x * stored[i], 0) / (norm(fresh) * norm(stored));
        console.log(JSON.stringify({ path: row.path, chunk: row.chunk_index, cosine }));
    }
} finally {
    await sql.end({ timeout: 1 });
}
