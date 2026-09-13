# RAG Architecture

## Package boundary

`@couchloom/rag` owns deterministic Markdown chunking, embeddings, vector
storage, and semantic retrieval. It does not know CouchDB, FastMCP, or process
environment variables. `@couchloom/server` wires vault change events into it.

## Data model

`rag_documents` is keyed by `(vault_id, path)` and stores a content hash and
mtime. `rag_chunks` is keyed by `(vault_id, path, chunk_index)`, references its
document with cascading deletion, and stores text plus a pgvector embedding.
Every query filters by `vault_id` before ordering by cosine distance.

Re-indexing rules:

- unchanged content hash: no embedding request and no database write;
- create/update: embed deterministic chunks and replace the document in one
  transaction;
- delete event: remove the document; chunk rows cascade;
- embedding model/dimension changes require a new table migration or rebuild.

## Runtime configuration

- `DATABASE_URL`: enables pgvector RAG;
- `EMBEDDING_BASE_URL`: OpenAI-compatible API root;
- `EMBEDDING_API_KEY`: bearer token (optional for trusted local providers);
- `EMBEDDING_MODEL`: required model name;
- `EMBEDDING_DIMENSIONS`: positive integer matching model output;
- `RAG_CHUNK_CHARS`: target chunk size, default `1800`;
- `RAG_CHUNK_OVERLAP`: overlap size, default `200`.

If any required RAG variable is missing, semantic RAG stays disabled while
ordinary vault MCP tools continue to work. Secrets are never included in
status output or logs.

## Verification

Unit tests cover deterministic chunking, hash-based no-op indexing,
create/update/delete routing, vault isolation, and search result mapping. A
PostgreSQL integration test will run against the VM/container stack before
deployment.
