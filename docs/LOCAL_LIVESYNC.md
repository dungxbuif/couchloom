# Local LiveSync Runner

This repository uses the upstream Self-hosted LiveSync CLI as the sync
engine. CouchLoom remains the knowledge, indexing, and MCP layer; it does not
reimplement LiveSync replication.

## Layout

- Upstream checkout: `/Users/dungxbuif/workspace/obsidian-livesync`
- Pinned CLI source: tag `1.0.9-cli` at commit `9765569bb64559bf3479b86fe1cd1528eb1371e6`
- Local image recipe: [`tools/livesync/Dockerfile`](../tools/livesync/Dockerfile)
- Local vault: `/Users/dungxbuif/workspace/Obsidian Vault`
- LiveSync state and settings: `~/Library/Application Support/CouchLoom/livesync/obsidian-vault`
- Runner: [`tools/livesync/livesync.sh`](../tools/livesync/livesync.sh)

The runner reads CouchDB credentials from the existing homelab
`local_vars.json` by default. It writes a mode-`0600` settings file outside
Git, persists LiveSync's migrated remote profile, and never prints the password.

## Commands

```bash
tools/livesync/livesync.sh build
tools/livesync/livesync.sh doctor
tools/livesync/livesync.sh remote-status
tools/livesync/livesync.sh sync
tools/livesync/livesync.sh mirror
tools/livesync/livesync.sh daemon
```

`sync` performs one CouchDB replication cycle without changing the Markdown
vault. `mirror` reconciles the local LiveSync database with the Markdown vault.
`daemon` keeps both directions running and should only be enabled after the
first sync and mirror pass have been verified.

Override paths or credentials with `LIVESYNC_*` environment variables. The
important path variables are `LIVESYNC_VAULT_DIR`, `LIVESYNC_DB_DIR`,
`LIVESYNC_SETTINGS_PATH`, and `LIVESYNC_VARS_FILE`.

## Current blocker

The first real sync reached CouchDB successfully but was rejected because the
remote LiveSync milestone is locked and this new node is not accepted. This is
expected protection during a rebuild. Do not run `unlock-remote` from this
empty local state. Finish or verify the rebuild from the existing Obsidian
device first, then retry `sync` here.

## Relationship to CouchLoom production

This runner is optional. CouchLoom production does **not** call this CLI: its
VM100 runtime uses the vendored `livesync-commonlib` directly against the
CouchDB database, then consumes `_changes` for indexing and RAG. The runner is
only useful when a separate headless process must mirror a local Markdown vault
without relying on the Obsidian application.

The normal production path is:

```text
Obsidian + LiveSync plugin <-> CouchDB <-> CouchLoom on VM100 <-> OpenClaw MCP
```

## Deployment choice

The canonical runtime should be this local app/daemon. It owns the long-lived
LiveSync state, file watcher, retry behavior, and CouchDB connection.

n8n should be a thin orchestration layer later: schedule `sync`, trigger
`mirror` or reconciliation, send failure notifications, and call CouchLoom or
OpenClaw after a successful change. An n8n custom node should not own the
replication state or replace the daemon.
