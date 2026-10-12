# Architecture

## Overview

```
Obsidian (phone/desktop)
    ↕ LiveSync plugin
CouchDB (cloud or local)
    ↕ acknowledgement-aware change stream
MCP Server ── durable pg-boss queue ── Ollama embeddings
    ↕ metadata tools          ↕          PostgreSQL + pgvector
    ↕ MCP protocol over HTTP
AI Agents (Claude, Copilot, custom)
```

The MCP server sits between CouchDB (or the local filesystem) and AI agents. It provides tools for interacting with an Obsidian vault.

## Modes

### Filesystem mode (`VAULT_PATH`)
- Reads `.md` files directly from a vault directory
- File watcher (debounced, 100ms per path) detects external edits
- Startup: loads persisted index, diffs mtimes against filesystem, reads only changed files

### CouchDB mode (`COUCHDB_URL`)
- Uses `DirectFileManipulator` from [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib) to read/write CouchDB documents
- Handles E2E encryption (decrypt on read, encrypt on write) when `COUCHDB_PASSPHRASE` is set
- Handles chunk reassembly (large notes are split into chunks by LiveSync)
- Startup: loads persisted index, catches up via CouchDB `_changes` feed from stored `since` sequence
- Live watcher: `_changes` feed with `live: true` for real-time updates. It
  hydrates an `_id` → path map before subscribing so pathless CouchDB hard
  tombstones can evict metadata and vector rows. Metadata is applied first; a
  RAG job is then durably enqueued. The `since` checkpoint advances only after
  that callback succeeds, so a crash or PostgreSQL outage cannot acknowledge
  work that exists only in memory.

## Metadata Index (`packages/core/src/search.ts`)

A single `SearchIndex` class manages all indexed data in memory:

```
(no full-text search — metadata only)
knownPaths: Set<string>   ─── all indexed note paths
mtimes: Map<path, number> ─── modification timestamps
tags: Map<path, string[]> ─── extracted from frontmatter + inline #tags
links: Map<path, string[]>── outgoing [[wikilinks]] and [markdown](links.md)
backlinks: Map<target, Set<source>> ─── reverse link index (case-insensitive keys)
since: string             ─── CouchDB _changes sequence (CouchDB mode only)
```

### Persistence

Everything is serialized to a single JSON file at `DATA_DIR/<vault-hash>/search-index.json`:
- No full-text index (removed FlexSearch for memory efficiency)
- Metadata (mtimes, tags, links, since)
- Encrypted with AES-256-GCM when `COUCHDB_PASSPHRASE` is set
- Saved every 5 minutes + on graceful shutdown
- Concurrent saves guarded by a lock flag

### Startup flow

**CouchDB mode:**
```
Load persisted index from disk
  ↓ (has since?)
catchUp(since) via _changes feed
  → process updates (searchIndex.update)
  → process deletes (searchIndex.remove)
  → store new since
  ↓
Start live _changes watcher (since: current)
  → update metadata
  → durably upsert singleton RAG job (vault_id:path)
  → acknowledge the change and update since
```

**Filesystem mode:**
```
Load persisted index from disk
  ↓
Diff mtimes against filesystem
  → remove stale entries (deleted files)
  → read only changed/new files
  ↓
Start fs.watch (debounced, reads through vault.readNote for symlink safety)
```

**No persisted index (first startup or corrupted):**
```
CouchDB: catchUp(since: "0") → replays all changes
Filesystem: full scan of all .md files
```

### Fault tolerance
- Wrong passphrase / corrupted index: `loadFromDisk` catches errors, falls back to full rebuild
- DB nuked (invalid `since`): `catchUp` errors, clears index, rebuilds from `since: "0"`
- Volume nuked: no persisted index, full rebuild; auth tokens lost (users re-authenticate)
- Crash during save: concurrent save guard prevents corruption; next restart rebuilds
- PostgreSQL/Ollama outage: metadata remains available; jobs retry with bounded
  exponential backoff and terminal failures move to `rag-index-dead-letter`.
- Process restart: pending work survives in PostgreSQL. The worker rereads the
  current note, making duplicate and stale events idempotent.
- Index drift: startup and five-minute reconciliation enqueue missing, stale,
  model-mismatched, and orphaned documents without overlapping runs.

See [`docs/RAG_OPERATIONS.md`](docs/RAG_OPERATIONS.md) for the exact readiness,
metrics, alert, redrive, and recovery contracts.

## Vault Backend (`packages/core/src/vault-backend.ts`)

Interface shared by both modes:

```typescript
interface VaultBackend {
    init(): Promise<void>;
    close(): Promise<void>;
    readNote(path: string): Promise<string | null>;
    writeNote(path: string, content: string): Promise<boolean>;
    deleteNote(path: string): Promise<boolean>;
    moveNote(from: string, to: string): Promise<boolean>;
    getMetadata(path: string): Promise<NoteInfo | null>;
    listNotes(folder?: string): Promise<string[]>;
    listNotesWithMtime(folder?: string): Promise<NoteListing[]>;
    watchChanges?(callback): void | Promise<void>; // live changes
    catchUp?(since, callback): Promise<string>; // CouchDB only
}
```

### LocalVault (`packages/core/src/vault-local.ts`)
- `safePath()` resolves symlinks and blocks traversal
- `listNotesWithMtime()` uses glob + stat in parallel
- Filters `.obsidian/` directory

### CouchDB Vault (`packages/core/src/vault.ts`)
- `DirectFileManipulator` from the internally vendored LiveSync component for
  CouchDB reads, writes, encryption, and chunk reconstruction
- `validatePath()` blocks null bytes, `..`, absolute paths, length > 1000
- `catchUp()` uses PouchDB `_changes` API directly (same selector as live watcher)
- `watchChanges()` owns a raw live `_changes` feed so hard tombstones without
  path/type metadata can be resolved through the hydrated document-id map
- Shared `docToChange()` and `mdFilter()` helpers for both catch-up and live watch

The compatibility component lives at
`packages/core/lib/livesync-commonlib`. It is ordinary CouchLoom source, not a
Git submodule, and was imported from upstream commit
`50d4ab9c1a7d4f59ab29c7555b8dfb2d69555e92`. CouchLoom keeps only the runtime
source and upstream license; upstream repository/release/test administration is
not part of this repository.

## Authentication (`apps/server/src/auth.ts`)

Self-contained OAuth 2.1 provider with PKCE:

```
Agent connects → /oauth/authorize → password page → /oauth/approve
  → redirect with code → /oauth/token (PKCE verified) → access + refresh tokens
```

- Rate limiting with exponential backoff (capped at ~85 min)
- CSRF tokens rotated on each failed attempt
- Token persistence to disk (0600 permissions)
- Periodic cleanup of expired tokens and unused clients
- Also accepts static `Bearer <MCP_AUTH_TOKEN>` for non-OAuth clients

## Tools (`packages/core/src/tools.ts`)

Ten tools are registered via FastMCP. Every note operation is scoped by
`vault_id`:

| Tool | Reads from | Writes to |
|---|---|---|
| `read_note` | vault | — |
| `write_note` | — | vault + index |
| `edit_note` | vault | vault + index |
| `list_notes` | index (fallback: vault) | — |
| `list_folders` | index (fallback: vault) | — |
| `list_tags` | index | — |
| `search_notes` | pgvector index | — |
| `get_index_status` | metadata + RAG runtime | — |
| `get_note_metadata` | vault + index (backlinks) | — |
| `list_vaults` | vault registry | — |

Delete and move methods remain available behind the internal backend interface
for synchronization bookkeeping, but are never registered as MCP tools.

## Build (`packages/core/tsup.config.ts`)

livesync-commonlib is a Deno-style TypeScript library compiled for Node via tsup/esbuild:

- `@lib/` alias → `packages/core/lib/livesync-commonlib/src/`
- `@/` alias → `packages/core/src/stubs/` (Node stubs for browser-only code)
- Extension resolution: tries `.ts`, then `/index.ts`
- Stubs: svelte, events, KeyValueDB, hub, logger (not used in headless mode)
- `pouchdb-browser` → `pouchdb-http` (no IndexedDB in Node)
- `bgWorker` → mock (no web workers in Node)
- Navigator polyfill in banner

## Dependencies

- **vendored LiveSync component** — CouchDB document handling, chunk
  reassembly, and E2E encryption owned inside `packages/core/lib`
- **FastMCP** — MCP server framework
- **Hono** — HTTP framework (used by FastMCP, we add OAuth routes)
- **PouchDB** — CouchDB client (transitive via livesync-commonlib)

## Test layout

- `packages/core/test/unit` — backend, parsing, metadata, tool, and safety tests.
- `packages/rag/test/unit` — deterministic chunking and indexer tests.
- `packages/rag/test/integration` — PostgreSQL/pgvector integration tests.
- `apps/server/test/unit` — configuration, authentication, and runtime tests.
- `apps/server/test/e2e` — process-level MCP and CouchDB tests.

The server TypeScript config maps `@couchloom/core` and `@couchloom/rag` to
their public source entry points for development and unit tests. Production
builds still consume the package exports from `dist`; tests therefore do not
depend on generated files left in the working tree.
