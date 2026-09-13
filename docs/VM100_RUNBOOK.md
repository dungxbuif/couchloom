# VM100 Runbook

## Services

The production Compose stack runs CouchLoom and PostgreSQL with pgvector.
CouchDB and the embedding endpoint may already exist elsewhere in the homelab.
The pgvector image is pinned to `pgvector/pgvector:0.8.6-pg17-bookworm`.

## First deployment

1. Clone `git@github.com:dungxbuif/couchloom.git` on VM100.
2. Copy `.env.example` to `.env`; replace every placeholder and set
   `VAULTS_CONFIG` to a compact JSON array.
3. Run `docker compose build` and `docker compose up -d`.
4. Verify `curl -fsS http://127.0.0.1:8787/health` and `/ready`.
5. Connect OpenClaw to `http://vm100:8787/mcp` with the bearer token.
6. Call `list_vaults`, `get_index_status`, and `search_notes` for every vault.

Do not expose ports 5432 or 8787 publicly. Bind through the private homelab
network or reverse proxy with TLS. Back up the `pgvector_data` volume and the
configured CouchDB databases independently.

## Upgrade

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose logs -f couchloom
```

The service runs idempotent `CREATE TABLE IF NOT EXISTS` migrations at startup.
Changing `EMBEDDING_DIMENSIONS` on an existing database requires a planned
rebuild because pgvector dimensions are part of the column type.

## Rollback

Check out the previous Git commit and rebuild only CouchLoom. Do not downgrade
the PostgreSQL data directory across PostgreSQL major versions. Derived vector
rows may be discarded and rebuilt from CouchDB; CouchDB remains the source of
truth.
