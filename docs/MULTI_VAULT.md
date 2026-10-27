# Multi-vault Configuration

## Foundation contract

CouchLoom identifies every vault with a stable lowercase `vault_id` matching
`^[a-z0-9][a-z0-9_-]{0,63}$`. IDs must be unique because they will namespace
MCP requests, index checkpoints, documents, and pgvector rows.

Configuration is loaded in this order:

1. `VAULTS_CONFIG_FILE` — path to a JSON file containing a vault array;
2. `VAULTS_CONFIG` — the same JSON array inline;
3. legacy single-vault variables (`VAULT_PATH` or `COUCHDB_URL`).

Setting both multi-vault sources is an error. A CouchDB vault requires URL,
database, user, and password. A local vault requires an absolute vault path.
Secrets remain runtime configuration and must not be logged.

Example:

```json
[
  {
    "id": "personal",
    "name": "Personal",
    "mode": "couchdb",
    "url": "http://couchdb:5984",
    "database": "vault_personal",
    "user": "admin",
    "password": "${injected-by-secret-store}",
    "passphrase": "${optional-e2e-secret}",
    "obfuscatePaths": false
  }
]
```

The runtime creates one backend, metadata index, persisted checkpoint, and
change watcher per configured vault. MCP exposes `list_vaults`; every other
note tool requires `vault_id` and resolves only that registry context.

## VM100 onboarding procedure

CouchLoom does not auto-discover CouchDB databases. Add a vault deliberately so
that its database, credentials, checkpoint, and vector namespace are explicit.

### 1. Prepare the source database

Create a dedicated CouchDB database for the new vault and grant the existing
non-admin sync user access. Configure Obsidian LiveSync to use that database,
then complete the initial sync. Do not point two unrelated vaults at the same
database.

A local directory is not enough: the vault must be synced into CouchDB, or the
server must be run in local filesystem mode for development.

### 2. Add the runtime entry

On VM100, back up the mode-`0600` runtime file before editing it:

```bash
sudo cp /opt/apps/couchloom/run/vaults.json \
  "/opt/apps/couchloom/run/vaults.json.bak-$(date +%Y%m%d-%H%M%S)"
sudoedit /opt/apps/couchloom/run/vaults.json
```

Append an object with a unique stable ID. Keep the real password out of Git
and out of chat/log output:

```json
{
  "id": "work",
  "name": "Work",
  "mode": "couchdb",
  "url": "http://couchdb:5984",
  "database": "work_vault",
  "user": "obsidian_sync",
  "password": "<runtime-secret>",
  "passphrase": "",
  "obfuscatePaths": false
}
```

The ID must match `^[a-z0-9][a-z0-9_-]{0,63}$`. Match `passphrase` and
`obfuscatePaths` to the LiveSync database settings. Validate the JSON and file
permissions without printing the secret:

```bash
sudo jq empty /opt/apps/couchloom/run/vaults.json
sudo test "$(stat -c '%a' /opt/apps/couchloom/run/vaults.json)" = 600
```

### 3. Restart only CouchLoom

The configuration is loaded at process startup; no image rebuild is required:

```bash
cd /opt/apps/couchloom/src
docker compose \
  -f deploy/vm100/compose.yml \
  --env-file /opt/apps/couchloom/run/.env \
  up -d --no-deps couchloom
```

Watch for the new registry and metadata index:

```bash
docker logs --tail 100 couchloom
```

The first startup reads the new vault and queues its RAG backfill. VM100 uses
CPU-only `nomic-embed-text` with a 2 vCPU cap, so semantic indexing may take
time while health and metadata MCP remain available.

### 4. Verify the new vault

From an authenticated MCP client:

```text
list_vaults()
get_index_status(vault_id="work")
search_notes(vault_id="work", query="project", limit=3)
read_note(vault_id="work", path="<path returned by search>")
```

Expected results are a listed vault, a non-empty `_changes` checkpoint after
sync, `rag.enabled=true` when pgvector/embeddings are configured, and search
results scoped only to `work`. Verify `/health` and `/ready` before handing the
vault to an agent.

### 5. Removing or renaming a vault

Removing an entry from `vaults.json` revokes CouchLoom access after restart but
does not automatically purge its derived pgvector rows. Treat database removal,
vector cleanup, and `vault_id` renaming as a planned migration. Never reuse a
`vault_id` for a different vault without reviewing its persisted index and
derived rows.

## Verification

- reject malformed JSON, duplicate/invalid IDs, relative local paths, and
  incomplete CouchDB credentials;
- preserve legacy single-vault startup;
- initialize registry entries in insertion order and close all initialized
  entries even when one close operation fails.
