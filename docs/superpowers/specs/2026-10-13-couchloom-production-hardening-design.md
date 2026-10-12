# CouchLoom Production Hardening Design

**Date:** 2026-10-13  
**Status:** Proposed for implementation  
**Scope:** Reliability, retrieval quality, observability, security, and recovery

## 1. Intent

CouchLoom is already a useful headless LiveSync knowledge service, but its RAG
index can silently fall behind when the local embedding service is unavailable.
The live deployment currently has 1,354 metadata notes but only 1,287 RAG
documents, or 95.05% semantic coverage. This design raises the service from a
working homelab deployment to a measurable, self-healing production service.

The intended outcome is:

- no accepted CouchDB change is permanently lost from the derived RAG index;
- partial RAG coverage is visible without taking metadata tools offline;
- retrieval quality is measured against a reproducible Vietnamese/English
  dataset before models or ranking strategies are changed;
- note contents and embedding inference remain self-hosted on VM100;
- operational recovery does not depend on SSHing into the VM and running
  ad-hoc commands.

## 2. Constraints and invariants

- CouchDB remains the source of truth for vault content.
- PostgreSQL and pgvector remain rebuildable derived state, except for durable
  job and authentication state explicitly stored there.
- Ollama and all embedding models remain hosted on VM100. Note content must not
  be sent to a cloud embedding provider.
- Existing MCP tool names and non-destructive tool policy remain compatible.
- Metadata tools remain available while RAG is catching up or degraded.
- Every indexing operation must be idempotent because CouchDB changes and queue
  jobs can be delivered more than once.
- The implementation must not introduce Redis, Qdrant, Typesense, OpenSearch,
  or Temporal in this milestone.

## 3. Selected approach

Use PostgreSQL as the durable job substrate, PostgreSQL full-text search as the
lexical retriever, and pgvector as the dense retriever.

The preferred job implementation is `pg-boss` because it supplies persistent
jobs, retries, exponential backoff, jitter, heartbeats, expiration, dead-letter
handling, and redrive while reusing the existing PostgreSQL service. Graphile
Worker is the fallback if a compatibility spike shows that pg-boss cannot run
reliably under the pinned Bun runtime.

Dedicated search engines were rejected for the current scale. The deployed RAG
store is approximately 31 MB and contains 5,128 chunks, so PostgreSQL can serve
exact dense and lexical queries without another stateful service.

## 4. Architecture

```text
CouchDB changes / MCP writes
            |
            v
  durable rag-index job
            |
            v
  worker reads latest note
            |
            +----> Markdown-aware chunks
            |               |
            |               +----> tsvector / GIN
            |               +----> Ollama on VM100 ----> pgvector
            |
            v
  job success, retry, or dead-letter

periodic reconciliation ----------------------------------^

query ----> lexical candidates + dense candidates ----> RRF ----> MCP result
```

The event path records work before attempting embeddings. The worker always
reads the latest note state, so jobs do not duplicate plaintext note content in
the queue. A delete job removes the corresponding document and chunks. An
update job becomes a no-op when the stored content hash already matches.

Advancing the CouchDB checkpoint is conditional on durable job persistence. A
catch-up batch or watched change must first write or deduplicate every required
job in PostgreSQL; only then may CouchLoom persist the corresponding CouchDB
sequence. If PostgreSQL is unavailable, the sequence remains uncommitted so the
change is replayed after recovery. This cross-system ordering is the boundary
that prevents a successfully observed change from being lost between CouchDB
and the RAG queue.

## 5. Durable indexing jobs

### 5.1 Job identity and payload

Each job carries:

```json
{
  "vaultId": "personal",
  "path": "projects/example.md",
  "observedMtime": 1791880000000
}
```

The singleton key is `vaultId:path`. A newer event for the same note supersedes
pending older work because the worker reads the current content from the vault.
No note content, CouchDB credential, or encryption passphrase is stored in the
job payload.

### 5.2 Retry policy

- use exponential backoff with jitter;
- default to 10 attempts;
- cap retry delay at 15 minutes;
- heartbeat long embedding calls;
- retain terminal failures for operator inspection and redrive;
- expose the last error without exposing note content or credentials.

A job is successful only after the document metadata and all chunks commit in
one transaction. Shutdown stops claiming new work, waits for active work up to
a bounded grace period, and leaves unfinished jobs recoverable by the queue.

### 5.3 Concurrency

Default embedding concurrency is one on VM100. It may be raised to two only
after CPU, memory, error rate, and p95 latency measurements show headroom. Queue
claiming may be concurrent, but only the configured number of embedding jobs
may call Ollama simultaneously.

## 6. Reconciliation

Reconciliation runs after startup and every five minutes by default. For every
vault it compares the metadata index with `rag_documents` and enqueues:

- missing RAG documents;
- documents indexed by a different embedding model;
- documents whose stored hash is stale;
- deletions for RAG documents whose source note no longer exists.

Reconciliation is bounded and resumable. It does not wait for all embeddings
before the MCP server begins serving metadata requests. Its interval is
configurable, and overlapping runs are prohibited.

The first hardened deployment must reconcile the current 67 missing documents
and reach 100% coverage unless a document is permanently invalid. Permanently
invalid documents remain visible as failed records with a reason.

## 7. Readiness, status, and metrics

`/health` remains a process liveness check.

`/ready` reports core availability separately from RAG state. It returns HTTP
503 only when the vault/metadata service cannot serve requests. A usable service
with incomplete RAG returns HTTP 200 with `rag.state` equal to `backfilling` or
`degraded`.

`get_index_status` returns, per vault:

- expected and indexed document counts;
- backlog and terminal-failure counts;
- coverage ratio;
- oldest pending job age;
- embedding model;
- last successful indexing time;
- last error summary;
- last reconciliation time;
- CouchDB checkpoint and watcher lag where available.

The server exposes Prometheus metrics for counts, coverage, job age, retries,
failures, reconciliation duration, watcher lag, embedding latency, and search
latency. Metrics must not contain note paths, query text, tokens, or secrets.

Initial service objectives are:

- RAG coverage reaches 100% after backfill;
- coverage stays at or above 99.9% within 15 minutes of a source change;
- oldest pending job stays below 10 minutes;
- terminal failed job count is zero;
- warm search p95 stays below 300 ms;
- cold search p95 stays below one second.

## 8. Retrieval-quality design

### 8.1 Evaluation first

Create a versioned golden dataset of 50 to 100 real queries covering
Vietnamese, English, mixed-language notes, exact identifiers, paraphrases, and
multi-concept questions. Each query names one or more relevant note paths and,
where practical, relevant headings or chunks.

Every retrieval change records:

- Recall@5;
- MRR@10;
- nDCG@10;
- zero-result rate;
- warm and cold latency;
- model, dimensions, chunking configuration, and corpus revision.

Target values are Recall@5 >= 0.90, MRR@10 >= 0.75, and zero-result rate below
2%. No model migration or reranker becomes the default without improving the
golden-set result at acceptable latency and resource use.

### 8.2 Hybrid retrieval

Each chunk stores a PostgreSQL `tsvector` built with a language-neutral
configuration suitable for mixed Vietnamese and English content. A GIN index
supports lexical retrieval. Dense cosine results and lexical results are fused
with Reciprocal Rank Fusion rather than adding incompatible raw scores.

Exact pgvector search remains the default at the current corpus size. HNSW is a
future optimization triggered by measured vector-query cost, not by this
milestone. If HNSW is later enabled, recall must be compared against exact
search and vault filtering must use iterative scans or partitioning as needed.

### 8.3 Markdown-aware chunks

Chunks preserve semantic structure rather than relying only on character
boundaries:

- keep heading hierarchy with each chunk;
- add note path/title and selected non-sensitive frontmatter as retrieval
  context;
- avoid splitting fenced code blocks, tables, and Obsidian callouts;
- target 300 to 500 tokens with 50 to 80 tokens of overlap;
- store heading and source offsets for traceability.

### 8.4 Self-hosted model experiment

The benchmark compares the existing `nomic-embed-text` baseline against:

- `qwen3-embedding:0.6b`, the preferred multilingual candidate;
- `embeddinggemma`, the low-resource candidate;
- `bge-m3`, the larger multilingual candidate.

All candidates run through Ollama on VM100. Query and document encoding may
use different model-specific prefixes or instructions. A model or dimension
change creates a new index generation identified by model, dimensions,
chunking version, and retrieval configuration. The active generation remains
queryable while the new generation backfills. An atomic configuration switch
promotes the new generation only after evaluation and coverage checks pass;
rollback switches back to the prior generation. Old generations are removed
only after an explicit retention period, so incompatible vectors never share a
query path silently.

A local reranker is explicitly deferred. It is introduced only if the golden
dataset shows that hybrid retrieval still misses the ranking target and VM100
has sufficient latency and memory headroom.

## 9. Security hardening

- Separate the bootstrap/login secret from ordinary bearer access.
- Store hashes of access and refresh tokens rather than recoverable token
  values where protocol behavior permits.
- Add per-client scopes for read, write, and allowed vault/folder boundaries.
- Make rate limiting client/IP-aware so an unauthenticated caller cannot impose
  a global login lockout.
- Record structured audit events for authentication and every write operation;
  never log note bodies or secrets.
- Keep the service behind private networking and TLS.
- Run containers as non-root with dropped capabilities,
  `no-new-privileges`, read-only root filesystems where compatible, explicit
  writable volumes/tmpfs, health checks, and CPU/memory limits.
- Load production secrets from a managed encrypted source rather than committed
  files or long-lived plaintext environment files.
- Pin production images by immutable version/digest and add dependency,
  container-image, and secret scanning to CI.

Existing non-destructive MCP policy remains unchanged: delete, move, and rename
tools are outside this milestone.

## 10. Backup and recovery

CouchDB content receives a scheduled independent backup or replication target.
PostgreSQL receives encrypted scheduled backups once it owns durable queue or
authentication state. Backup success alone is insufficient: an automated
restore drill must reconstruct the services in an isolated environment and run
coverage and MCP smoke checks.

The operational runbook covers:

- Ollama unavailable during indexing;
- PostgreSQL unavailable;
- CouchDB changes feed disconnected;
- dead-letter inspection and redrive;
- full RAG rebuild;
- model migration rollback;
- CouchDB and PostgreSQL restore verification.

## 11. Verification strategy

Unit tests use fake clocks and fault-injecting providers to cover retry timing,
jitter bounds, deduplication, stale events, delete/update races, shutdown, and
status aggregation.

PostgreSQL integration tests cover job durability across process restart,
transaction rollback, redrive, reconciliation, hybrid ranking, vault isolation,
and migration idempotence.

End-to-end and failure-injection tests must prove:

1. kill Ollama while updates arrive, restore it, and reach full coverage;
2. restart CouchLoom with pending and active work and lose no note;
3. restart PostgreSQL and recover queue processing;
4. disconnect and resume the CouchDB changes feed from its checkpoint;
5. index duplicate changes without duplicate chunks;
6. continue serving metadata while RAG is degraded;
7. restore backups into an isolated stack and pass MCP smoke tests;
8. preserve the existing complete unit-test suite.

## 12. Rollout order

1. Add durable jobs and deterministic failure tests.
2. Add reconciliation, extended status, and metrics.
3. Deploy with the existing `nomic-embed-text` model and repair the missing 67
   documents.
4. Add alerts and complete failure/recovery drills.
5. Build the golden retrieval dataset.
6. Add Markdown-aware chunking and PostgreSQL hybrid retrieval.
7. Benchmark local embedding candidates and migrate only on measured gain.
8. Apply authentication, container, backup, and supply-chain hardening.

Each stage has a rollback path and must leave metadata MCP available. Model and
chunking migrations use explicit index identity so mixed incompatible vectors
cannot silently coexist.

## 13. Completion criteria

The hardening milestone is complete when:

- the production index has 100% explainable coverage;
- no job is lost across the documented failure scenarios;
- status and Prometheus metrics expose backlog and staleness without secrets;
- alerts and restore drills have been exercised successfully;
- the selected retrieval configuration meets the golden-set targets;
- all embedding inference remains on VM100;
- security controls and operational behavior are documented for both humans
  and AI agents;
- build, unit, integration, end-to-end, and deployment smoke checks pass.
