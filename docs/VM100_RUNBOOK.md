# VM100 Runbook

## Production topology

The VM100 deployment is a private Docker Compose application attached to the
existing attachable Swarm overlay `homelab-net`. It does not publish a host or
public port.

| Service | Network | Purpose |
| --- | --- | --- |
| `couchloom` | `couchloom-internal`, `homelab-net` | MCP/API, LiveSync parser, event listener, indexer |
| `couchloom-postgres` | private `couchloom-internal` bridge only | PostgreSQL 17 + pgvector derived index |
| `couchloom-ollama` | private `couchloom-internal` bridge only | CPU embeddings with `nomic-embed-text` |
| `ollama-model` init job | private bridge, exits after success | Pull the pinned embedding model through bridge egress |
| `couchdb` | existing `homelab-net` service | source-of-truth LiveSync documents |
| `openclaw` | existing `homelab-net` service | MCP client/agent |

Images are version-pinned. Vault credentials are stored in a mode-`0600`
`vaults.json` file mounted read-only; application secrets remain in a
mode-`0600` `.env` file. Neither file is committed.

The private bridge publishes no ports, but keeps normal outbound connectivity so
the one-shot bootstrap job can download the model. Only CouchLoom joins
`homelab-net`; PostgreSQL and the long-running Ollama server cannot be resolved
from other homelab workloads.

Internal dependency URLs use the unique container hostnames
`couchloom-postgres` and `couchloom-ollama`, not generic names such as
`postgres`, to avoid DNS collisions with existing services on `homelab-net`.

The CouchLoom container runs as the non-root `bun` user with every Linux
capability dropped, `no-new-privileges`, a read-only root filesystem, a bounded
`/tmp` tmpfs, and explicit CPU/memory limits. Its only persistent writable path
is `/data`. PostgreSQL and Ollama retain writable managed volumes and are not
made read-only.

## First deployment

1. Clone `git@github.com:dungxbuif/couchloom.git` into
   `/opt/apps/couchloom/src` on VM100.
2. Create `/opt/apps/couchloom/run/.env` from
   `deploy/vm100/.env.example` and create
   `/opt/apps/couchloom/run/vaults.json` from
   `deploy/vm100/vaults.example.json`; set both files to `0600`.
3. From `/opt/apps/couchloom/src`, run
   `docker compose -f deploy/vm100/compose.yml --env-file ../run/.env up -d --build`.
4. Wait for the one-shot `ollama-model` service to pull the configured model.
5. Verify `/health`, `/ready`, `/metrics`, and the initial index status from the
   private network. `rag.state=backfilling` is expected until coverage reaches
   1; `rag.state=degraded` requires investigation but does not disable metadata.
6. Register `http://couchloom:8787/mcp` in OpenClaw with the bearer token.
7. Probe the MCP server, then call `list_vaults`, `get_index_status`, and
   `search_notes` for every vault.

Do not expose ports `5432`, `8787`, or `11434`. CouchDB remains the source of
truth; PostgreSQL vectors may be discarded and rebuilt. Back up CouchDB and
the mode-`0600` deployment configuration independently.

## Upgrade

```bash
git pull --ff-only
docker compose -f deploy/vm100/compose.yml --env-file ../run/.env build --pull couchloom
docker compose -f deploy/vm100/compose.yml --env-file ../run/.env up -d
docker compose -f deploy/vm100/compose.yml --env-file ../run/.env logs -f couchloom
```

The service runs idempotent `CREATE TABLE IF NOT EXISTS` migrations at startup.
Changing `EMBEDDING_DIMENSIONS` on an existing database requires a planned
rebuild because pgvector dimensions are part of the column type.

Before every upgrade, validate the rendered configuration and take the backups
described in [RAG operations](RAG_OPERATIONS.md):

```bash
docker compose -f deploy/vm100/compose.yml --env-file ../run/.env config --quiet
docker exec couchloom-postgres pg_dump -U couchloom -d couchloom -Fc \
  > ../run/couchloom-postgres-before-upgrade.dump
```

## Rollback

Check out the previous Git commit and rebuild only CouchLoom. Do not downgrade
the PostgreSQL data directory across PostgreSQL major versions. Derived vector
rows may be discarded and rebuilt from CouchDB; CouchDB remains the source of
truth.

If the new process is unhealthy, collect `docker compose ps` and the last 200
log lines, check out the previous known-good commit, rebuild only `couchloom`,
then verify `/ready` plus `get_index_status`. Do not delete PostgreSQL merely to
clear a queue: it holds durable pending/dead-letter work.

## RAG operations

The exact queue-inspection and redrive commands, alert thresholds, failure
runbooks, backup/restore checks, and full rebuild procedure are in
[`docs/RAG_OPERATIONS.md`](RAG_OPERATIONS.md). The operational invariants are:

- CouchDB remains the note source of truth;
- PostgreSQL is backed up because it now owns durable queue state;
- metadata tools stay usable during RAG outages;
- embedding requests remain inside VM100 through private Ollama;
- redrive only after the dependency or configuration failure is corrected.

## Verification plan

- `docker compose ... config` succeeds without rendering secret values to logs.
- All three containers become healthy and remain portless on the host.
- `couchloom` resolves `couchdb` over `homelab-net`.
- `/health`, `/ready`, and `/metrics` return success from a temporary container
  on the overlay network.
- The initial `obsidian_vault` reconciliation reaches coverage `1`, backlog `0`,
  failed `0`, and semantic search returns a vault-scoped result.
- OpenClaw MCP probe succeeds with authenticated Streamable HTTP.
- A temporary note can be created and then edited through MCP; deletion remains
  unavailable by design.
