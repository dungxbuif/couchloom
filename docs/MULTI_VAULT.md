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

## Verification

- reject malformed JSON, duplicate/invalid IDs, relative local paths, and
  incomplete CouchDB credentials;
- preserve legacy single-vault startup;
- initialize registry entries in insertion order and close all initialized
  entries even when one close operation fails.
