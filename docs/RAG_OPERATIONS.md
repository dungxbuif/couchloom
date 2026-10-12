# RAG Operations

This runbook operates CouchLoom's durable RAG pipeline on VM100. CouchDB is the
source of truth for notes. PostgreSQL owns the derived vector index **and the
durable pg-boss queue**, so back it up even though vectors can be rebuilt.
Embedding inference must remain on the private `couchloom-ollama` service.

All commands assume `/opt/apps/couchloom/src` and the production env file at
`../run/.env`. They avoid printing note bodies or credentials.

## Normal state

`GET /health` proves the process is alive. `GET /ready` separates core service
availability from RAG quality:

| HTTP | `rag.state` | Meaning | Operator action |
| --- | --- | --- | --- |
| 200 | `disabled` | Core works; RAG is not configured | Configure RAG if semantic search is required |
| 200 | `ready` | Coverage complete, no backlog/failures | None |
| 200 | `backfilling` | Core works; RAG is catching up | Observe backlog and age |
| 200 | `degraded` | Core works; RAG has failures or an active error | Repair dependency/config and redrive |
| 503 | any | Core vault/metadata service cannot serve | Roll back or restore the core service |

The MCP `get_index_status` tool supplies per-vault counts and timestamps.
Metadata tools remain available during an Ollama or RAG failure.

Probe from a container already attached to `homelab-net`:

```bash
curl -fsS http://couchloom:8787/health
curl -fsS http://couchloom:8787/ready
curl -fsS http://couchloom:8787/metrics
```

## Queue inspection and redrive

Show aggregate queue states without printing job data or note paths:

```bash
docker exec couchloom bun -e '
import { PgBoss } from "pg-boss";
const boss = new PgBoss(process.env.DATABASE_URL);
await boss.start();
for (const name of ["rag-index", "rag-index-dead-letter"]) {
  const jobs = await boss.findJobs(name);
  const states = Object.groupBy(jobs, job => job.state);
  console.log(JSON.stringify({queue:name,counts:Object.fromEntries(Object.entries(states).map(([state,items])=>[state,items.length]))}));
}
await boss.stop({graceful:true});'
```

Correct the underlying failure first. Then move terminal work back to the
source queue:

```bash
docker exec couchloom bun -e '
import { PgBoss } from "pg-boss";
const boss = new PgBoss(process.env.DATABASE_URL);
await boss.start();
const redriven = await boss.redrive("rag-index-dead-letter", {sourceName:"rag-index"});
console.log(JSON.stringify({redriven}));
await boss.stop({graceful:true});'
```

Redrive is idempotent at the document layer: the worker rereads the current
note and transactionally replaces its rows. Never delete pg-boss tables by
hand. If a failure recurs, retain it for diagnosis instead of repeatedly
redriving.

## Reconciliation and recovery

Reconciliation runs at startup and every `RAG_RECONCILE_INTERVAL_MS` (default
five minutes). It enqueues missing documents, stale hashes, model mismatches,
and orphan deletions. Runs never overlap. A process restart is the supported
manual trigger; pending jobs survive because PostgreSQL is durable.

### Ollama unavailable

1. Confirm core readiness remains HTTP 200 and `rag.state` is `backfilling` or
   `degraded`.
2. Check `docker compose ... ps` and `docker logs --tail 200 couchloom-ollama`.
3. Restart only Ollama if needed and verify the configured model with
   `docker exec couchloom-ollama ollama list`.
4. Watch backlog and oldest-job age fall. Redrive terminal jobs after Ollama is
   healthy.

### PostgreSQL unavailable

1. Treat this as a durable-work outage: CouchDB changes are not acknowledged
   past work that cannot be enqueued.
2. Inspect `couchloom-postgres` health, disk space, and logs; restore service
   without reinitializing its volume.
3. After PostgreSQL is healthy, restart CouchLoom to rebuild both the pg-boss
   and pgvector connection pools. Its stored CouchDB checkpoint resumes the
   change stream, and durable queued work remains in PostgreSQL.
4. Verify backlog drains, failed is zero, and coverage returns to 1.

### CouchDB change feed disconnected

1. Verify CouchDB DNS/connectivity on `homelab-net` and inspect CouchLoom logs.
2. Restore connectivity. The watcher reconnects from the last acknowledged
   checkpoint; duplicate delivery is safe.
3. Verify `get_index_status.checkpoint` advances and reconciliation restores
   coverage.

### Full RAG rebuild

Use this only for a dimension/model migration or irreparable derived-index
corruption. Take a PostgreSQL backup first. Stop CouchLoom so no jobs race the
operation, remove only `rag_chunks` and `rag_documents` in one transaction,
then start CouchLoom. Startup reconciliation repopulates from CouchDB. Do not
drop the pg-boss schema.

```bash
docker compose -f deploy/vm100/compose.yml --env-file ../run/.env stop couchloom
docker exec couchloom-postgres psql -U couchloom -d couchloom \
  -v ON_ERROR_STOP=1 -c 'BEGIN; DELETE FROM rag_chunks; DELETE FROM rag_documents; COMMIT;'
docker compose -f deploy/vm100/compose.yml --env-file ../run/.env up -d couchloom
```

Rollback a model change by restoring the previous model/dimension configuration
and a compatible pre-migration PostgreSQL backup, or by repeating the derived
index rebuild with the previous model. Mixed model identities are detected and
requeued; mixed vector dimensions are not supported in one table.

## Metrics and initial alerts

All metrics use only `vault_id` and bounded state labels. They never label note
paths, note text, search queries, tokens, or credentials.

| Metric | Purpose |
| --- | --- |
| `couchloom_rag_documents_expected` | Markdown documents known to metadata |
| `couchloom_rag_documents_indexed` | RAG document rows |
| `couchloom_rag_coverage_ratio` | Indexed/expected, from 0 to 1 |
| `couchloom_rag_queue_jobs{state}` | queued, active, retrying, failed jobs |
| `couchloom_rag_oldest_job_age_seconds` | age of oldest queued/retrying job |
| `couchloom_rag_retries_total` | observed retry attempts |
| `couchloom_rag_failures_total` | processing failures |
| `couchloom_rag_reconciliation_duration_seconds` | reconciliation latency histogram |
| `couchloom_rag_embedding_duration_seconds` | embed+persist latency histogram |
| `couchloom_rag_search_duration_seconds` | semantic-search latency histogram |
| `couchloom_couchdb_watcher_lag` | change-feed lag when measurable |

Start with these alerts, then tune from production history:

- critical: `couchloom_rag_queue_jobs{state="failed"} > 0` for 5 minutes;
- warning: `couchloom_rag_oldest_job_age_seconds >= 600` for 5 minutes;
- warning: coverage below `0.999` for 15 minutes after a source change;
- warning: warm search p95 at or above 0.3 seconds for 15 minutes;
- warning: cold search p95 at or above 1 second for 15 minutes;
- critical: no successful PostgreSQL or CouchDB backup in the scheduled window.

The target steady state is coverage 1, backlog 0, failed 0, and oldest-job age
0. A counter increase is diagnostic; use the queue gauges and status timestamps
to decide whether the service has recovered.

## Backup and restore verification

Back up CouchDB independently using the homelab CouchDB replication/backup
policy. Back up PostgreSQL with a non-plain custom dump and protect the file as
a secret-bearing artifact:

```bash
umask 077
docker exec couchloom-postgres pg_dump -U couchloom -d couchloom -Fc \
  > ../run/couchloom-postgres-$(date +%Y%m%dT%H%M%S).dump
```

A backup is not accepted until an isolated restore drill succeeds. Restore into
a disposable PostgreSQL instance of the same major version, start CouchLoom
against a non-production CouchDB copy, then verify `/health`, `/ready`,
`list_vaults`, `get_index_status`, metadata read, semantic search, backlog 0,
failed 0, and expected coverage. Never point a restore drill at production
CouchDB with write tools enabled.

## Configuration reference

| Variable | Default | Meaning |
| --- | ---: | --- |
| `RAG_RETRY_LIMIT` | `10` | attempts before dead-letter |
| `RAG_RETRY_DELAY_SECONDS` | `1` | initial retry delay |
| `RAG_RETRY_DELAY_MAX_SECONDS` | `900` | exponential-backoff cap |
| `RAG_JOB_HEARTBEAT_SECONDS` | `30` | active-job heartbeat |
| `RAG_JOB_EXPIRE_SECONDS` | `3600` | hard job execution bound; heartbeat detects dead workers |
| `RAG_QUEUE_SUPERVISE_INTERVAL_SECONDS` | `30` | expired-claim scan interval |
| `RAG_DATABASE_CONNECT_TIMEOUT_MS` | `5000` | queue reconnect attempt bound |
| `RAG_RECONCILE_INTERVAL_MS` | `300000` | drift-repair interval |
| `RAG_WORKER_CONCURRENCY` | `1` | simultaneous embedding jobs |
| `RAG_SHUTDOWN_GRACE_MS` | `30000` | graceful queue-stop bound |

Keep concurrency at one on VM100 unless measured CPU, memory, failure rate, and
p95 latency demonstrate headroom. Never replace the VM100
`EMBEDDING_BASE_URL=http://couchloom-ollama:11434/v1` with a public provider.

## Latest production evidence

The 2026-10-13 VM100 rollout of commit `bbe0243` reached 1,357/1,357 indexed
documents and 6,074 chunks with coverage 1, backlog 0, and failed 0. A
controlled Ollama outage kept metadata available, retained one pending change,
and converged 23 seconds after Ollama restart. Ten warm semantic searches
measured p50 102.3 ms and p95 122.9 ms. See
[`docs/VM100_RUNBOOK.md`](VM100_RUNBOOK.md) for image, backup, rollback, and
resource evidence.

The rollout also demonstrated that five minutes is too short for a legitimate
large-note batch on CPU Ollama. `RAG_JOB_EXPIRE_SECONDS=3600` is intentional:
the one-hour value bounds genuine long work, while the 30-second heartbeat and
supervisor detect an abandoned worker. Do not reduce the hard bound without
measuring the largest production document workload.
