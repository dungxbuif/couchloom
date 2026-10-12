# RAG Architecture

## Package boundary

`@couchloom/rag` owns deterministic Markdown chunking, embeddings, vector
storage, and semantic retrieval. It does not know CouchDB, FastMCP, or process
environment variables. `@couchloom/server` wires vault events, durable jobs,
reconciliation, readiness, and metrics around it.

## Data model

`rag_documents` is keyed by `(vault_id, path)` and stores a content hash, mtime,
and embedding-model identity. `rag_chunks` is keyed by
`(vault_id, path, chunk_index)`, references its document with cascading
deletion, and stores text plus a pgvector embedding. Every search filters by
`vault_id` before ordering by cosine distance.

Re-indexing rules:

- unchanged content hash and matching model: no embedding request or database
  write;
- create/update: embed deterministic chunks and replace the document in one
  transaction;
- delete: remove the document; chunk rows cascade;
- a model-identity change forces re-embedding even when content is unchanged;
- vector-dimension changes require a planned table rebuild.

## Durable change flow

```text
CouchDB change
  -> update metadata index
  -> pg-boss upsert(rag-index, singleton vault_id:path)
  -> acknowledge CouchDB sequence
  -> worker rereads current note
  -> embed locally with Ollama
  -> transactionally replace rag_documents + rag_chunks
```

The job payload is limited to `vaultId`, `path`, and `observedMtime`; it never
stores note content, a query, a token, or a credential. A newer pending event
for the same note supersedes older pending data. The worker always rereads the
current note, so stale updates and deletes converge safely.

The `rag-index` queue defaults to one worker, 10 retry attempts, exponential
backoff from one second capped at 900 seconds, a 30-second heartbeat, and the
`rag-index-dead-letter` destination. A crashed worker's claim expires after 300
seconds and a 30-second supervisor cycle reclaims it; live workers refresh the
claim through heartbeats. Graceful shutdown stops queue processing and waits up
to 30 seconds; uncompleted work remains durable.

## Reconciliation

Reconciliation runs once after startup and every five minutes by default. It
compares metadata source paths and hashes with `rag_documents`, then enqueues
missing, stale, model-mismatched, and orphaned documents. It is idempotent,
resumable, and guarded against overlap. It does not block metadata MCP tools
while embeddings catch up.

## Runtime configuration

- `DATABASE_URL`: enables pgvector RAG;
- `EMBEDDING_BASE_URL`: OpenAI-compatible API root;
- `EMBEDDING_API_KEY`: bearer token (optional for trusted local providers);
- `EMBEDDING_MODEL`: required model name;
- `EMBEDDING_DIMENSIONS`: positive integer matching model output;
- `RAG_CHUNK_CHARS`: target chunk size, default `1800`;
- `RAG_CHUNK_OVERLAP`: overlap size, default `200`;
- `RAG_RETRY_LIMIT`: attempts before dead-letter, default `10`;
- `RAG_RETRY_DELAY_SECONDS`: initial retry delay, default `1`;
- `RAG_RETRY_DELAY_MAX_SECONDS`: retry-delay cap, default `900`;
- `RAG_JOB_HEARTBEAT_SECONDS`: active-job heartbeat, default `30`;
- `RAG_JOB_EXPIRE_SECONDS`: crashed-worker claim expiry, default `300`;
- `RAG_QUEUE_SUPERVISE_INTERVAL_SECONDS`: expired-claim scan, default `30`;
- `RAG_DATABASE_CONNECT_TIMEOUT_MS`: queue reconnect attempt bound, default `5000`;
- `RAG_RECONCILE_INTERVAL_MS`: reconciliation interval, default `300000`;
- `RAG_WORKER_CONCURRENCY`: simultaneous embedding jobs, default `1`;
- `RAG_SHUTDOWN_GRACE_MS`: graceful queue-stop bound, default `30000`.

If required RAG configuration is missing, semantic RAG stays disabled while
ordinary vault MCP tools continue to work. Secrets are never included in
status output or logs.

The VM100 deployment fixes `EMBEDDING_BASE_URL` to its private Ollama service.
All embedding inference therefore stays on VM100; PostgreSQL and Ollama have no
published host ports.

## Status and telemetry

`get_index_status` exposes expected/indexed counts, coverage, backlog, terminal
failures, oldest-job age, model, last success/error/reconciliation, and the
CouchDB checkpoint. `/ready` returns HTTP 200 for `ready`, `backfilling`, and
RAG-only `degraded`; it returns 503 only when the core vault/metadata service is
unavailable. `/metrics` is Prometheus text and deliberately has no note-path or
query labels. The complete metric catalog and alert thresholds are maintained
in [`RAG_OPERATIONS.md`](RAG_OPERATIONS.md).

## Verification

Unit tests cover deterministic chunking, hash/model no-op rules,
create/update/delete routing, vault isolation, queue policy, acknowledgement,
reconciliation, status, and metrics. PostgreSQL integration tests cover vector
persistence and durable queue restart, retry, dead-letter, and redrive behavior
before deployment.
