# Architecture

## Overview

```
Obsidian (phone/desktop)
    ↕ LiveSync plugin
CouchDB (cloud or local)
    ↕ DirectFileManipulator (livesync-commonlib)
MCP Server (this project)
    ↕ MCP protocol over HTTP
AI Agents (Claude, Copilot, custom)
```

The MCP server sits between CouchDB (or the local filesystem) and AI agents. It provides tools for interacting with an Obsidian vault.

## Production topology

The VM100 profile runs CouchLoom as a private Compose application:

```text
Obsidian + LiveSync
        |
        v
Pi5 CouchDB / homelab-net  <---- CouchLoom (VM100)
                                  |       |
                                  v       v
                         PostgreSQL/pgvector  Ollama
                                  |
                                  v
                         authenticated MCP /mcp
```

Only CouchLoom joins the existing `homelab-net` overlay. PostgreSQL and the
long-running Ollama service stay on the private `couchloom-internal` bridge;
the deployment publishes no host ports. Ollama currently serves
`nomic-embed-text` over an internal OpenAI-compatible endpoint and is capped at
2 vCPU on VM100. The exact operational procedure is in
[`docs/VM100_RUNBOOK.md`](docs/VM100_RUNBOOK.md).

The service is configuration-driven rather than CouchDB-database-discovery
driven. Every configured CouchDB database becomes one registry entry with its
own checkpoint, metadata index namespace, and RAG namespace. See
[`docs/MULTI_VAULT.md`](docs/MULTI_VAULT.md).

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
  tombstones can evict metadata and vector rows, and advances `since` for every
  event so reconnects resume from the latest observed sequence.

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
  → updates since on each change
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

## Data-flow contracts

1. LiveSync writes canonical documents to CouchDB.
2. CouchLoom consumes CouchDB `_changes`, reconstructs Markdown, and updates
   the per-vault metadata index/checkpoint.
3. The RAG runtime chunks changed Markdown, requests embeddings, and stores
   derived rows in pgvector keyed by `(vault_id, path, chunk_index)`.
4. MCP read/search tools resolve a configured `vault_id` and never cross
   vault namespaces.
5. MCP writes go back through the LiveSync-compatible backend; subsequent
   `_changes` events reconcile the same state.

Metadata readiness and RAG readiness are deliberately separate. MCP can serve
after metadata indexing while the first vector backfill continues in the
background. Restarting with a persisted CouchDB checkpoint requeues RAG
reconciliation without rebuilding the source database.

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
