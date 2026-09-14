# VM100 Runbook

## Production topology

The VM100 deployment is a private Docker Compose application attached to the
existing attachable Swarm overlay `homelab-net`. It does not publish a host or
public port.

| Service | Network | Purpose |
| --- | --- | --- |
| `couchloom` | `couchloom-internal`, `homelab-net` | MCP/API, LiveSync parser, event listener, indexer |
| `couchloom-postgres` | `couchloom-internal` only | PostgreSQL 17 + pgvector derived index |
| `couchloom-ollama` | `couchloom-internal` only | CPU embeddings with `nomic-embed-text` |
| `couchdb` | existing `homelab-net` service | source-of-truth LiveSync documents |
| `openclaw` | existing `homelab-net` service | MCP client/agent |

Images are version-pinned. Vault credentials are stored in a mode-`0600`
`vaults.json` file mounted read-only; application secrets remain in a
mode-`0600` `.env` file. Neither file is committed.

## First deployment

1. Clone `git@github.com:dungxbuif/couchloom.git` into
   `/opt/apps/couchloom/src` on VM100.
2. Create `/opt/apps/couchloom/run/.env` from
   `deploy/vm100/.env.example` and create
   `/opt/apps/couchloom/run/vaults.json` from
   `deploy/vm100/vaults.example.json`; set both files to `0600`.
3. From `/opt/apps/couchloom/src`, run
   `docker compose -f deploy/vm100/compose.yml --env-file ../run/.env up -d --build`.
4. Pull the embedding model once with
   `docker exec couchloom-ollama ollama pull nomic-embed-text`.
5. Verify health from the private network and inspect the initial index status.
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

## Rollback

Check out the previous Git commit and rebuild only CouchLoom. Do not downgrade
the PostgreSQL data directory across PostgreSQL major versions. Derived vector
rows may be discarded and rebuilt from CouchDB; CouchDB remains the source of
truth.

## Verification plan

- `docker compose ... config` succeeds without rendering secret values to logs.
- All three containers become healthy and remain portless on the host.
- `couchloom` resolves `couchdb` over `homelab-net`.
- `/health` and `/ready` return success from a temporary container on the
  overlay network.
- The initial `obsidian_vault` rebuild completes and semantic search returns a
  vault-scoped result.
- OpenClaw MCP probe succeeds with authenticated Streamable HTTP.
- A temporary note can be created and then edited through MCP; deletion remains
  unavailable by design.
