# VM100 Runbook

## Production topology

The VM100 deployment is a private Docker Compose application attached to the
existing attachable Swarm overlay `homelab-net`. It does not publish a host or
public port.

| Service | Network | Purpose |
| --- | --- | --- |
| `couchloom` | `couchloom-internal`, `homelab-net` | MCP/API, direct LiveSync CouchDB reader/writer, event listener, indexer |
| `couchloom-postgres` | private `couchloom-internal` bridge only | PostgreSQL 17 + pgvector derived index |
| `couchloom-ollama` | private `couchloom-internal` bridge only | CPU embeddings with `nomic-embed-text`, limited to 2 vCPU on VM100 |
| `ollama-model` init job | private bridge, exits after success | Pull the pinned embedding model through bridge egress |
| `couchdb` | existing `homelab-net` service | source-of-truth LiveSync documents |
| `openclaw` | existing `homelab-net` service | MCP client/agent |

Images are version-pinned. Vault credentials are stored in a mode-`0600`
`vaults.json` file mounted read-only; application secrets remain in a
mode-`0600` `.env` file. Neither file is committed.

The private bridge publishes no ports, but keeps normal outbound connectivity so
the one-shot bootstrap job can download the model. Only CouchLoom joins
`homelab-net`; PostgreSQL and the long-running Ollama server cannot be resolved
from other homelab workloads. CouchLoom uses the vendored
`livesync-commonlib` directly against CouchDB; no local Obsidian vault or
LiveSync CLI process is mounted on VM100.

Internal dependency URLs use the unique container hostnames
`couchloom-postgres` and `couchloom-ollama`, not generic names such as
`postgres`, to avoid DNS collisions with existing services on `homelab-net`.

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

## Current deployment (2026-10-05)

VM100 is running image `couchloom:vm100-20261005-direct-couchdb` from
`/opt/apps/couchloom/src` with the existing mode-`0600` runtime configuration.
The deployment is private and has no published host ports. The `couchloom`
container is healthy and serves authenticated Streamable HTTP MCP on its
internal `8787` port.

Verified after deployment:

- CouchLoom loaded vault `personal` and indexed `1,223` notes from the
  LiveSync-compatible `obsidian_vault` CouchDB database.
- `/health` and `/ready` passed the container healthcheck.
- Authenticated MCP `initialize`, `tools/list`, and `list_vaults` returned
  successfully; the tool catalog includes `search_notes`.
- PostgreSQL/pgvector contained `509` documents and `1,411` chunks at the
  verification point. RAG reconciliation continues in the background and is
  safe to resume after restart.
- `couchloom-postgres` and `couchloom-ollama` remained healthy; the host
  exposes no CouchLoom, PostgreSQL, or Ollama port.
- Ollama is intentionally limited to `2.0` CPUs after measuring roughly
  `570%` CPU during unrestricted RAG backfill. This protects the Proxmox host;
  the trade-off is slower embedding throughput until GPU passthrough is
  available.

The optional local LiveSync CLI runner is not part of this VM100 deployment.
OpenClaw registration and a production note write-back UAT are still pending.

## Add a CouchDB vault

Use [`docs/MULTI_VAULT.md`](MULTI_VAULT.md) for the full contract. The short
VM100 procedure is:

1. Create a dedicated CouchDB database and complete the initial Obsidian
   LiveSync sync.
2. Back up and edit `/opt/apps/couchloom/run/vaults.json`; add a unique stable
   `id`, display name, CouchDB URL/database/user/password, and matching
   LiveSync encryption settings. Keep the file mode at `0600`.
3. Validate with `sudo jq empty` and restart only CouchLoom:

   ```bash
   cd /opt/apps/couchloom/src
   docker compose -f deploy/vm100/compose.yml \
     --env-file /opt/apps/couchloom/run/.env \
     up -d --no-deps couchloom
   ```

4. Verify `list_vaults`, `get_index_status`, and a vault-scoped
   `search_notes` call. The new vault gets its own `_changes` checkpoint and
   pgvector namespace; its initial RAG backfill runs in the background.

Do not expect CouchLoom to discover arbitrary CouchDB databases, and do not
assume a local Obsidian directory is connected unless it has been synced to the
configured CouchDB database. Removing a config entry revokes access but does
not by itself delete derived vector rows.

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
- `couchloom` resolves `couchdb` over `homelab-net` and opens the LiveSync-compatible database directly.
- `/health` and `/ready` return success from a temporary container on the
  overlay network.
- The metadata index becomes ready and the service starts serving MCP while
  the initial `obsidian_vault` RAG backfill continues in the background;
  semantic search is verified after the backfill reaches the target document
  count. A restart requeues persisted notes and resumes an interrupted RAG
  backfill without rebuilding CouchDB.
- OpenClaw MCP probe succeeds with authenticated Streamable HTTP.
- A temporary note can be created and then edited through MCP; deletion remains
  unavailable by design.
