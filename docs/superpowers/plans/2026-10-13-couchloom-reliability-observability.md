# CouchLoom Reliability and Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CouchLoom's RAG index durable, self-healing, and observable, then restore production semantic coverage from 95.05% to 100% or an explicitly explained terminal-failure state.

**Architecture:** CouchDB change callbacks become acknowledgement-aware so a checkpoint advances only after a durable pg-boss job exists. A single-concurrency worker reads the latest note from its vault and applies the existing idempotent `RagIndexer`; periodic reconciliation requeues missing/stale documents and removes orphans. Status, readiness, and Prometheus metrics expose coverage, backlog, failures, lag, and latency without exposing note content or paths.

**Tech Stack:** TypeScript, Bun 1.3.14, CouchDB/PouchDB changes feed, PostgreSQL 17, pgvector 0.8.6, pg-boss 12.37.1, prom-client 15.1.3, Ollama on VM100

**Spec:** `docs/superpowers/specs/2026-10-13-couchloom-production-hardening-design.md`

## Global Constraints

- CouchDB remains the source of truth; PostgreSQL/pgvector remain derived state except durable job/authentication state.
- All embedding inference remains in Ollama on VM100; note content must not be sent to any cloud provider.
- Preserve existing MCP tool names, safe write policy, and metadata availability while RAG is degraded.
- Indexing is idempotent and may receive duplicate CouchDB changes or queue jobs.
- Do not add Redis, Qdrant, Typesense, OpenSearch, or Temporal.
- Default reconciliation interval is 300,000 ms; default worker concurrency is 1.
- Default queue policy is 10 retries, exponential backoff with jitter, maximum retry delay 900 seconds, and heartbeat-enabled work.
- `/health` remains liveness; `/ready` returns 503 only when core vault metadata cannot serve.
- Metrics and logs must not contain note bodies, query text, credentials, tokens, passphrases, or note paths.
- Work in an isolated worktree created from commit `f965c7d`; do not modify, stage, or discard the user's existing dirty checkout.
- Update human docs and the AI-readable `llms.txt` in the same tasks as behavior/configuration changes.

## Review Focus

- A queue insert failure during CouchDB catch-up must leave the persisted checkpoint unchanged; covered in Task 2 acknowledgement tests.
- A newer edit arriving while the same note is actively embedding must cause a later job or current-content re-read, never a lost update; covered in Task 3 upsert/worker tests.
- A hard delete whose source note no longer exists must remove its RAG document without trying to embed; covered in Task 4 reconciliation tests.
- A failed or slow Ollama call must leave metadata MCP usable and expose degraded RAG state without leaking the path; covered in Tasks 4 and 5.
- Shutdown during active work must leave the job recoverable after restart and must not advance its source checkpoint; covered in Task 3 integration tests.

---

## File structure

- `packages/core/src/vault-backend.ts` — asynchronous change-callback contract.
- `packages/core/src/vault.ts` — ordered, acknowledgement-aware CouchDB catch-up and live feed.
- `packages/core/test/unit/change-ack.test.ts` — deterministic ordering and failure behavior for acknowledged changes.
- `apps/server/src/rag-job-queue.ts` — pg-boss adapter and queue-facing types.
- `apps/server/test/unit/rag-job-queue.test.ts` — adapter behavior using a fake boss boundary.
- `apps/server/test/integration/rag-job-queue.integration.test.ts` — real PostgreSQL durability/restart behavior.
- `apps/server/src/rag-runtime.ts` — RAG inventory, indexing generation identity, counts, and timed operations.
- `packages/rag/src/indexer.ts` — document inventory interfaces needed by reconciliation.
- `packages/rag/src/pgvector-store.ts` — inventory/status SQL and supporting migration.
- `apps/server/src/vault-runtime.ts` — durable enqueue, worker source reads, reconciliation, and per-vault state.
- `apps/server/src/rag-status.ts` — stable status types and aggregation.
- `apps/server/src/metrics.ts` — Prometheus registry and metric recording.
- `apps/server/src/main.ts` — startup/shutdown order, worker wiring, readiness, metrics endpoint, scheduler.
- `packages/core/src/vault-registry.ts` — richer RAG status contract.
- `packages/core/src/tools.ts` — expanded `get_index_status` output.
- `deploy/vm100/compose.yml` — retry/reconciliation settings and resource/security guardrails.
- `README.md`, `ARCHITECTURE.md`, `docs/RAG_ARCHITECTURE.md`, `docs/VM100_RUNBOOK.md`, `llms.txt` — operator and agent-readable behavior.

### Task 1: pg-boss compatibility and durable queue adapter

**Files:**
- Modify: `apps/server/package.json`
- Modify: `bun.lock`
- Create: `apps/server/src/rag-job-queue.ts`
- Create: `apps/server/test/unit/rag-job-queue.test.ts`
- Create: `apps/server/test/integration/rag-job-queue.integration.test.ts`
- Modify: `apps/server/package.json` test scripts

**Interfaces:**
- Produces: `RagIndexJob { vaultId: string; path: string; observedMtime?: number }`.
- Produces: `RagQueueStats { queued: number; active: number; retrying: number; failed: number; oldestQueuedAt: string | null }`.
- Produces: `RagJobQueue.start(): Promise<void>`, `enqueue(job: RagIndexJob): Promise<void>`, `work(handler: (job: RagIndexJob) => Promise<void>): Promise<void>`, `stats(vaultId?: string): Promise<RagQueueStats>`, `redrive(): Promise<number>`, and `close(): Promise<void>`.
- Consumes later: Tasks 2–5 use only the adapter interface and do not import pg-boss directly.

- [ ] **Step 1: Add failing adapter tests**

Test that `enqueue()` uses `upsert` with singleton key `${vaultId}:${path}`, retry limit 10, exponential backoff, maximum delay 900 seconds, heartbeat, and dead-letter destination. Test that two updates before activation keep the latest `observedMtime`, while an active job followed by a new edit leaves later work queued. Test global and vault-filtered `stats()` mapping and redrive without note paths in returned status.

- [ ] **Step 2: Run the adapter tests and verify RED**

Run: `bun test apps/server/test/unit/rag-job-queue.test.ts`  
Expected: FAIL because `rag-job-queue.ts` does not exist.

- [ ] **Step 3: Install pinned queue dependency and implement the adapter**

Add `pg-boss@12.37.1`. Implement the interfaces above with queue names `rag-index` and `rag-index-dead-letter`, standard queue policy, `upsert()` for not-yet-active jobs, and worker concurrency 1. Keep pg-boss types behind the adapter.

- [ ] **Step 4: Run adapter tests and typecheck**

Run: `bun test apps/server/test/unit/rag-job-queue.test.ts && bun run build`  
Expected: PASS and successful build.

- [ ] **Step 5: Add and run a PostgreSQL compatibility test**

The integration test starts the adapter against `TEST_DATABASE_URL`, enqueues a job, stops the first adapter, starts a second adapter, processes the job once, then verifies retry and dead-letter/redrive behavior with an intentionally failing handler.

Run: `TEST_DATABASE_URL=postgres://... bun test apps/server/test/integration/rag-job-queue.integration.test.ts`  
Expected: PASS under Bun 1.3.14 and PostgreSQL 17. If pg-boss is incompatible, stop implementation and revise the spec to use Graphile Worker; do not silently introduce a custom queue.

- [ ] **Step 6: Commit**

```bash
git add apps/server/package.json bun.lock apps/server/src/rag-job-queue.ts apps/server/test/unit/rag-job-queue.test.ts apps/server/test/integration/rag-job-queue.integration.test.ts
git commit -m "feat: add durable RAG job queue"
```

### Task 2: Acknowledgement-aware CouchDB changes

**Files:**
- Modify: `packages/core/src/vault-backend.ts`
- Modify: `packages/core/src/vault.ts`
- Create: `packages/core/src/change-ack.ts`
- Create: `packages/core/test/unit/change-ack.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `VaultChangeCallback = (path: string, content: string | null, mtime?: number, seq?: string | number) => void | Promise<void>`.
- Produces: `AcknowledgedChangeStream.enqueue(seq: string, apply: () => Promise<void>): Promise<void>`, `checkpoint: string`, and `drain(): Promise<void>`.
- Consumes: Task 3 supplies a callback that resolves only after `RagJobQueue.enqueue()` commits.

- [ ] **Step 1: Write failing acknowledgement tests**

Test ordered callbacks, checkpoint advancement only after callback resolution, unchanged checkpoint after callback rejection, ignored later events after the first failure in a feed generation, and successful replay from the last acknowledged sequence.

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test packages/core/test/unit/change-ack.test.ts`  
Expected: FAIL because acknowledgement types/helper do not exist.

- [ ] **Step 3: Implement the callback contract and serial acknowledgement helper**

Change `catchUp` and `watchChanges` callback types to `VaultChangeCallback`. Make catch-up await each Markdown callback before `onBatch`. Route live events through one serial `AcknowledgedChangeStream`; update `manipulator.since` only after callback success. On callback failure cancel the current feed, discard later events from that generation, and reconnect after 10 seconds from the last acknowledged sequence.

- [ ] **Step 4: Run core tests**

Run: `bun run --cwd packages/core test`  
Expected: 0 failures, including acknowledgement regression tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/vault-backend.ts packages/core/src/vault.ts packages/core/src/change-ack.ts packages/core/src/index.ts packages/core/test/unit/change-ack.test.ts
git commit -m "fix: acknowledge CouchDB changes after durable work"
```

### Task 3: Wire durable jobs into server lifecycle

**Files:**
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/vault-runtime.ts`
- Create: `apps/server/test/unit/vault-runtime-rag-queue.test.ts`
- Modify: `apps/server/test/e2e/mcp.e2e.test.ts`

**Interfaces:**
- Consumes: `RagJobQueue` and `VaultChangeCallback` from Tasks 1–2.
- Produces: `VaultRuntime.enqueueRag(path: string, mtime?: number): Promise<void>` and `processRagJob(path: string): Promise<void>`.
- Produces: lifecycle order `rag.start -> queue.start -> vault.start -> queue.work`; shutdown order `stop reconciliation -> queue.close -> vault.close -> rag.close`.

- [ ] **Step 1: Write failing runtime tests**

Use injected fake backend, fake queue, and fake RAG apply function. Assert that catch-up waits for durable enqueue, the worker rereads current content, missing content routes to delete, queue failure prevents checkpoint advancement, a newer edit during active processing schedules later work, and metadata remains readable when processing throws.

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test apps/server/test/unit/vault-runtime-rag-queue.test.ts`  
Expected: FAIL because queue injection and processing methods do not exist.

- [ ] **Step 3: Implement runtime injection and lifecycle wiring**

Replace direct `rag.apply()` calls on change with durable `queue.enqueue()`. Start the worker only after all vault backends initialize, map `vaultId` to its runtime, reread the latest note in the worker, then call `rag.apply(vaultId, path, content, mtime)`. Bound shutdown wait with `RAG_SHUTDOWN_GRACE_MS`, default 30,000 ms.

- [ ] **Step 4: Run server and root tests**

Run: `bun run --cwd apps/server test && bun run test`  
Expected: 0 failures.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/main.ts apps/server/src/vault-runtime.ts apps/server/test/unit/vault-runtime-rag-queue.test.ts apps/server/test/e2e/mcp.e2e.test.ts
git commit -m "feat: process RAG changes through durable jobs"
```

### Task 4: RAG inventory, reconciliation, and status

**Files:**
- Modify: `packages/rag/src/indexer.ts`
- Modify: `packages/rag/src/pgvector-store.ts`
- Modify: `packages/rag/src/index.ts`
- Modify: `apps/server/src/rag-runtime.ts`
- Create: `apps/server/src/rag-status.ts`
- Modify: `apps/server/src/vault-runtime.ts`
- Modify: `packages/core/src/vault-registry.ts`
- Modify: `packages/core/src/tools.ts`
- Create: `apps/server/test/unit/rag-reconciliation.test.ts`
- Modify: `packages/rag/test/integration/pgvector.integration.test.ts`
- Modify: `packages/core/test/unit/tools.test.ts`

**Interfaces:**
- Produces: `VectorDocumentState { path: string; contentHash: string; mtime: number; embeddingModel: string; updatedAt: string }` and `VectorStore.listDocuments(vaultId: string): Promise<VectorDocumentState[]>`.
- Produces: `RagIndexStatus { enabled; state; model; expected; indexed; backlog; failed; coverage; oldestJobAgeSeconds; lastSuccessAt; lastError; lastReconciliationAt; checkpoint }`.
- Produces: `VaultRuntime.reconcileRag(): Promise<void>` guarded against overlap.

- [ ] **Step 1: Write failing inventory/reconciliation tests**

Cover missing source documents, stale hashes, model mismatch, orphan RAG rows, empty notes, a permanently failed job, zero expected notes (`coverage=1`), and overlapping reconciliation calls. Assert failure summaries omit the note path.

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test apps/server/test/unit/rag-reconciliation.test.ts packages/core/test/unit/tools.test.ts`  
Expected: FAIL because inventory and rich status contracts do not exist.

- [ ] **Step 3: Add vector-store inventory queries**

Implement `listDocuments`, `countDocuments`, and migration-safe indexes required by inventory queries. Keep SQL vault-scoped and cover it in the PostgreSQL integration test.

- [ ] **Step 4: Implement reconciliation and status aggregation**

At startup and every `RAG_RECONCILE_INTERVAL_MS` (default 300,000), compare source paths with vector documents. Read each source note, compute the same SHA-256 content hash used by `RagIndexer`, and enqueue missing, stale, and model-mismatched notes; enqueue orphan paths so worker deletion is idempotent. Collect vault-filtered queue stats and RAG timestamps into `RagIndexStatus`.

- [ ] **Step 5: Expand `get_index_status`**

Return stable JSON containing all `RagIndexStatus` fields. Preserve the old `enabled` and `model` information. Add tool tests for disabled, ready, backfilling, and degraded states.

- [ ] **Step 6: Run unit and PostgreSQL integration tests**

Run: `bun run test && TEST_DATABASE_URL=postgres://... bun test packages/rag/test/integration/pgvector.integration.test.ts`  
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/rag/src/indexer.ts packages/rag/src/pgvector-store.ts packages/rag/src/index.ts packages/rag/test/integration/pgvector.integration.test.ts apps/server/src/rag-runtime.ts apps/server/src/rag-status.ts apps/server/src/vault-runtime.ts apps/server/test/unit/rag-reconciliation.test.ts packages/core/src/vault-registry.ts packages/core/src/tools.ts packages/core/test/unit/tools.test.ts
git commit -m "feat: reconcile and report RAG coverage"
```

### Task 5: Readiness and Prometheus metrics

**Files:**
- Modify: `apps/server/package.json`
- Modify: `bun.lock`
- Create: `apps/server/src/metrics.ts`
- Modify: `apps/server/src/main.ts`
- Create: `apps/server/test/unit/metrics.test.ts`
- Modify: `apps/server/test/e2e/mcp.e2e.test.ts`

**Interfaces:**
- Produces: `CouchLoomMetrics` record methods for expected/indexed documents, queue states, retries, failures, reconciliation duration, embedding duration, search duration, and watcher lag.
- Produces: unauthenticated private-network `GET /metrics` in Prometheus text format.
- Produces: `GET /ready` response `{ status, vaults, rag: { enabled, state, coverage, backlog, failed } }`.

- [ ] **Step 1: Write failing metric/readiness tests**

Assert metric names/help/types, no path/query labels, repeated initialization safety, `ready` HTTP 200 for `ready`, `backfilling`, and `degraded`, and HTTP 503 only when core readiness is false.

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test apps/server/test/unit/metrics.test.ts apps/server/test/e2e/mcp.e2e.test.ts`  
Expected: FAIL because metrics and readiness aggregation do not exist.

- [ ] **Step 3: Add prom-client and implement metrics**

Add `prom-client@15.1.3`. Use a dedicated registry to prevent duplicate global registration in tests. Add the `/metrics` endpoint with `text/plain; version=0.0.4` and record durations around existing RAG operations.

- [ ] **Step 4: Implement degraded-aware readiness**

Aggregate all vault status objects. Return status `ready`, `backfilling`, or `degraded` with HTTP 200 while core vaults are usable; use HTTP 503 only for core unavailability.

- [ ] **Step 5: Run tests and build**

Run: `bun run test && bun run build`  
Expected: all tests and builds pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server/package.json bun.lock apps/server/src/metrics.ts apps/server/src/main.ts apps/server/test/unit/metrics.test.ts apps/server/test/e2e/mcp.e2e.test.ts
git commit -m "feat: expose RAG readiness and metrics"
```

### Task 6: Deployment configuration and documentation

**Files:**
- Modify: `deploy/vm100/compose.yml`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/RAG_ARCHITECTURE.md`
- Modify: `docs/VM100_RUNBOOK.md`
- Modify: `llms.txt`
- Create: `docs/RAG_OPERATIONS.md`

**Interfaces:**
- Consumes: configuration and status contracts from Tasks 1–5.
- Produces: documented variables `RAG_RETRY_LIMIT=10`, `RAG_RETRY_DELAY_SECONDS=1`, `RAG_RETRY_DELAY_MAX_SECONDS=900`, `RAG_JOB_HEARTBEAT_SECONDS=30`, `RAG_RECONCILE_INTERVAL_MS=300000`, `RAG_WORKER_CONCURRENCY=1`, and `RAG_SHUTDOWN_GRACE_MS=30000`.

- [ ] **Step 1: Update operator documentation before deployment configuration**

Document behavior, failure semantics, queue/redrive commands, readiness states, metric names, alert thresholds, reconciliation, recovery, and local-only embedding invariant. Update `llms.txt` with the same stable endpoint/config catalog for agents.

- [ ] **Step 2: Update VM100 Compose configuration**

Add explicit environment defaults and healthcheck behavior. Add `init: true`, `security_opt: [no-new-privileges:true]`, `cap_drop: [ALL]`, and conservative CouchLoom CPU/memory limits after verifying Bun can write only to `/data` and required temp locations; add `tmpfs` for `/tmp`. Do not make PostgreSQL or Ollama read-only in this task.

- [ ] **Step 3: Validate documentation and Compose**

Run: `docker compose -f deploy/vm100/compose.yml config >/dev/null && bun run build && bun run test`  
Expected: valid Compose, successful build, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add deploy/vm100/compose.yml README.md ARCHITECTURE.md docs/RAG_ARCHITECTURE.md docs/VM100_RUNBOOK.md docs/RAG_OPERATIONS.md llms.txt
git commit -m "docs: add durable RAG operations and deployment controls"
```

### Task 7: Failure drills and production rollout

**Files:**
- Modify: `apps/server/test/e2e/multi-vault.e2e.test.ts`
- Create: `apps/server/test/e2e/rag-recovery.e2e.test.ts`
- Create: `apps/server/test/smoke-test.md`
- Modify: `docs/VM100_RUNBOOK.md`
- Modify: `docs/RAG_OPERATIONS.md`

**Interfaces:**
- Consumes: all prior task interfaces.
- Produces: repeatable automated recovery test and recorded production validation evidence.

- [ ] **Step 1: Add failing recovery E2E scenarios**

Cover Ollama outage during updates, CouchLoom restart with queued/active work, PostgreSQL restart, duplicate CouchDB changes, hard delete, and metadata availability during degraded RAG.

- [ ] **Step 2: Run recovery tests and verify they detect the unhardened failure mode**

Run: `bun test apps/server/test/e2e/rag-recovery.e2e.test.ts`  
Expected before final fixtures/wiring: at least the outage/restart assertion fails; after implementation, all scenarios pass.

- [ ] **Step 3: Run complete local verification**

Run: `bun run build && bun run test && bun run test:e2e && bun run test:pgvector`  
Expected: all commands pass with zero skipped hardening scenarios.

- [ ] **Step 4: Back up VM100 configuration and PostgreSQL before rollout**

Use the existing VM100 runbook backup procedure. Record backup identifiers and verify they are readable before replacing containers. Do not delete the previous image.

- [ ] **Step 5: Deploy and run failure-safe smoke checks**

Build a versioned CouchLoom image, apply the validated Compose file, and verify `/health`, `/ready`, `/metrics`, `list_vaults`, `get_index_status`, metadata search, semantic search, and write-scope behavior. Confirm all three containers are healthy with zero unexpected restarts.

- [ ] **Step 6: Wait for reconciliation and verify coverage**

Expected: `expected=1354`, `indexed=1354`, `backlog=0`, `failed=0`, and `coverage=1`, unless the source count changed during rollout. If a note is permanently invalid, record its redacted failure class and leave status explicitly degraded rather than reporting false success.

- [ ] **Step 7: Exercise one controlled Ollama outage**

Stop Ollama, edit a designated fixture note through the allowed MCP path, confirm a retry/backlog appears while metadata remains available, restart Ollama, confirm coverage returns to 100%, then restore the fixture's exact prior content through `edit_note`.

- [ ] **Step 8: Reconcile runbooks with actual production evidence**

Record observed recovery time, final counts, latency, resource use, and rollback image/config identifiers in `docs/VM100_RUNBOOK.md` and `docs/RAG_OPERATIONS.md`.

- [ ] **Step 9: Commit**

```bash
git add apps/server/test/e2e/multi-vault.e2e.test.ts apps/server/test/e2e/rag-recovery.e2e.test.ts apps/server/test/smoke-test.md docs/VM100_RUNBOOK.md docs/RAG_OPERATIONS.md
git commit -m "test: verify durable RAG recovery"
```

### Task 8: Foundation completion gate

**Files:**
- Modify only if reconciliation finds drift: `README.md`, `ARCHITECTURE.md`, `docs/RAG_ARCHITECTURE.md`, `docs/RAG_OPERATIONS.md`, `docs/VM100_RUNBOOK.md`, `llms.txt`

**Interfaces:**
- Produces: verified foundation required by the retrieval-quality and security/recovery implementation plans.

- [ ] **Step 1: Run final verification from a clean checkout**

Run: `bun install --frozen-lockfile && bun run build && bun run test && bun run test:e2e && bun run test:pgvector`  
Expected: every command exits 0.

- [ ] **Step 2: Verify repository and production state**

Confirm no secrets or note content entered git history, metrics, logs, or test fixtures; inspect `git diff --check`; confirm production coverage/SLO status and rollback artifacts.

- [ ] **Step 3: Reconcile documentation**

Compare every documented variable, endpoint field, metric, command, and failure procedure with shipped code. Correct drift in both human-facing docs and `llms.txt`.

- [ ] **Step 4: Commit any reconciliation-only corrections**

```bash
git add README.md ARCHITECTURE.md docs/RAG_ARCHITECTURE.md docs/RAG_OPERATIONS.md docs/VM100_RUNBOOK.md llms.txt
git commit -m "docs: reconcile RAG hardening behavior"
```

- [ ] **Step 5: Record next-plan inputs**

Capture the stable coverage, p50/p95 latency, CPU/RAM headroom, and failure-recovery timing needed to plan hybrid retrieval/model benchmarking and security/backup work. Do not begin those independent subsystems inside this plan.
