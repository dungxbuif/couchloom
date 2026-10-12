# CouchLoom hardening smoke test

This checklist is the release gate for the durable RAG rollout. Record exact
timestamps, image/config identifiers, redacted backup paths, and observed
values. Never paste secrets, note bodies, note paths, or query text.

## Automated recovery fixture

The local E2E fixture uses a disposable pgvector container, a controllable
OpenAI-compatible embedding server, a temporary local vault, and a real
CouchLoom process. It must prove:

- an embedding outage produces durable retry/backlog while metadata remains
  readable;
- a process restart preserves pending work and converges after recovery;
- an active job reclaimed after a crashed worker is idempotent;
- a PostgreSQL restart does not lose queued work;
- duplicate note events do not create duplicate chunks;
- a hard delete removes both metadata and its vector document;
- final coverage is 1 with backlog 0 and failed 0.

## Pre-rollout

- [x] `docker compose ... config --quiet`
- [x] clean build, unit, E2E, queue integration, and pgvector integration
- [x] readable mode-0600 backup of VM100 `.env` and `vaults.json`
- [x] readable PostgreSQL custom-format dump (`pg_restore --list`)
- [x] current image ID/tag and Git commit recorded as rollback identifiers
- [x] previous image retained locally

## Production smoke

- [x] `couchloom`, `couchloom-postgres`, and `couchloom-ollama` healthy
- [x] zero unexpected container restarts
- [x] `/health` returns 200
- [x] `/ready` returns 200 and exposes RAG state/counts
- [x] `/metrics` returns Prometheus text without content/path/query labels
- [x] authenticated `list_vaults` and `get_index_status`
- [x] metadata list/read succeeds
- [x] semantic search returns a vault-scoped result
- [x] create/edit follows the configured unrestricted non-destructive policy
- [x] delete/move/rename tools remain absent
- [x] reconciliation reaches current expected count, coverage 1, backlog 0,
      and failed 0

## Controlled Ollama outage

Use only the designated reversible fixture note and preserve its exact prior
content before editing.

- [x] stop Ollama and record timestamp
- [x] edit fixture through allowed MCP write path
- [x] metadata read shows the edit while RAG shows retry/backlog
- [x] restart Ollama and verify its configured model
- [x] coverage returns to 1; backlog and failed return to 0
- [x] restore exact prior fixture content through MCP
- [x] coverage returns to 1 again
- [x] record recovery duration and max backlog without recording the path

## Evidence

| Field | Value |
| --- | --- |
| Git commit | `bbe0243` |
| New image | `sha256:5b6e1d5c7540916615e51d5774fbe39e2b1cfdf8dd87cdbb12709d0cf1c7d526` |
| Rollback image | `sha256:e2aeb316cb3d73b3e125a1402fc031c67dce0998d3154e12985a1356ec79605d` |
| Config backup | `env-backup-20261013-0318`, `vaults-backup-20261013-0318.json` |
| PostgreSQL backup | `postgres-backup-20261013-0318.dump`, custom format verified readable |
| Rollout time (Asia/Ho_Chi_Minh) | 2026-10-13 03:34 |
| Final expected/indexed | 1,357 / 1,357; 6,074 chunks |
| Final backlog/failed/coverage | 0 / 0 / 1 |
| Controlled-outage recovery | 23 seconds after Ollama restart; max backlog 1; fixture restored exactly |
| Search latency sample | 10 warm calls: p50 102.3 ms, p95 122.9 ms |
| Container resource sample | CouchLoom 120.8 MiB/2 GiB; PostgreSQL 91.96 MiB; Ollama 316.6 MiB |
