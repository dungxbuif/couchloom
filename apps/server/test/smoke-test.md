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

- [ ] `docker compose ... config --quiet`
- [ ] clean build, unit, E2E, queue integration, and pgvector integration
- [ ] readable mode-0600 backup of VM100 `.env` and `vaults.json`
- [ ] readable PostgreSQL custom-format dump (`pg_restore --list`)
- [ ] current image ID/tag and Git commit recorded as rollback identifiers
- [ ] previous image retained locally

## Production smoke

- [ ] `couchloom`, `couchloom-postgres`, and `couchloom-ollama` healthy
- [ ] zero unexpected container restarts
- [ ] `/health` returns 200
- [ ] `/ready` returns 200 and exposes RAG state/counts
- [ ] `/metrics` returns Prometheus text without content/path/query labels
- [ ] authenticated `list_vaults` and `get_index_status`
- [ ] metadata list/read succeeds
- [ ] semantic search returns a vault-scoped result
- [ ] create/edit is restricted to configured write scope
- [ ] delete/move/rename tools remain absent
- [ ] reconciliation reaches current expected count, coverage 1, backlog 0,
      and failed 0

## Controlled Ollama outage

Use only the designated reversible fixture note and preserve its exact prior
content before editing.

- [ ] stop Ollama and record timestamp
- [ ] edit fixture through allowed MCP write path
- [ ] metadata read shows the edit while RAG shows retry/backlog
- [ ] restart Ollama and verify its configured model
- [ ] coverage returns to 1; backlog and failed return to 0
- [ ] restore exact prior fixture content through MCP
- [ ] coverage returns to 1 again
- [ ] record recovery duration and max backlog without recording the path

## Evidence

| Field | Value |
| --- | --- |
| Git commit | pending |
| New image | pending |
| Rollback image | pending |
| Config backup | pending |
| PostgreSQL backup | pending |
| Rollout time (Asia/Ho_Chi_Minh) | pending |
| Final expected/indexed | pending |
| Final backlog/failed/coverage | pending |
| Controlled-outage recovery | pending |
| Search latency sample | pending |
| Container resource sample | pending |
