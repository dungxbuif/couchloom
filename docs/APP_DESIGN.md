# CouchLoom App Design

## Product role

CouchLoom is a headless knowledge service for Obsidian vaults synchronized by
LiveSync. It is the retrieval and controlled write layer between CouchDB and
AI agents. It is not an Obsidian replacement, a second sync engine, or a
general-purpose document editor.

The product contract is:

```text
Obsidian + LiveSync -> CouchDB -> CouchLoom -> MCP client / agent
                                      |
                                      +-> pgvector semantic index
                                      +-> Ollama embeddings
```

CouchDB remains authoritative. CouchLoom can rebuild metadata and vector data
from CouchDB without changing the source vault.

## Users and clients

| Actor | Need | Interface |
| --- | --- | --- |
| Human Obsidian user | Keep notes synchronized and authoritative | Obsidian + LiveSync + CouchDB |
| AI agent | Discover, read, search, and safely update notes | Authenticated Streamable HTTP MCP |
| Automation workflow | Trigger retrieval or structured note updates | MCP client or a future HTTP/n8n adapter |
| Operator | Check readiness, indexing, resource use, and failures | `/health`, `/ready`, Docker logs, runbook |

CouchLoom currently has no end-user web UI. Its app surface is the MCP tool
catalog plus operational endpoints. Any future dashboard should be an
operator surface, not a second note editor.

## Core user journeys

### Ask a question

1. The client calls `list_vaults` and chooses a `vault_id`.
2. The agent calls `search_notes` with a natural-language query.
3. CouchLoom embeds the query, retrieves vault-scoped chunks, and returns
   note paths, scores, deep links, and excerpts.
4. The agent reads the most relevant notes with `read_note` and composes the
   answer. CouchLoom supplies retrieval context; it does not generate the
   final natural-language answer itself.

### Inspect a note

1. The agent uses `list_folders`, `list_notes`, or `search_notes` to locate a
   note.
2. It calls `read_note` for the complete Markdown body.
3. It may call `get_note_metadata` for frontmatter, tags, links, and
   backlinks.

### Write back safely

1. The agent identifies the target `vault_id` and path.
2. `write_note` creates or replaces a complete note, or `edit_note` applies a
   bounded append, prepend, or exact replacement.
3. CouchLoom writes through the LiveSync-compatible backend and updates the
   metadata/RAG pipeline.
4. The agent reads the note back before reporting success.

Agents cannot delete, move, or rename notes. Human changes observed through
LiveSync still reconcile metadata and vector rows, including deletions.

### Add a vault

Each vault gets a separate CouchDB database, stable `vault_id`, checkpoint,
metadata namespace, and pgvector namespace. The operator syncs the vault into
CouchDB first, adds a validated entry to `vaults.json`, restarts CouchLoom,
then verifies `list_vaults`, `get_index_status`, and `search_notes`. CouchLoom
does not auto-discover arbitrary CouchDB databases.

## Interaction design

The agent-facing experience follows these rules:

- Always discover vaults before note operations.
- Always pass `vault_id`; never infer a vault from a path alone.
- Prefer semantic search for intent and metadata/list tools for exact filters.
- Read the source note before editing it.
- After a write, read it back and show the returned Obsidian deep link.
- Treat search results as evidence, not as a final answer without reading the
  relevant note.
- Report when RAG is disabled, still backfilling, or has no semantic match.

## Operational states

| State | Meaning | Client behavior |
| --- | --- | --- |
| `health=ok` | Process is alive | Liveness only; dependencies may still be starting |
| `ready` | Vault metadata and configured dependencies are available | MCP requests may proceed |
| RAG enabled | pgvector and embedding provider are configured | `search_notes` is available |
| RAG backfill | Metadata is ready while vectors catch up | Serve MCP, disclose partial semantic coverage |
| RAG disabled | No database/embedding configuration | Use metadata/read tools; do not promise semantic search |
| Unknown `vault_id` | Client selected an unconfigured vault | Call `list_vaults` and retry with a valid ID |

## Safety and trust boundaries

- CouchDB is the source of truth; PostgreSQL is derived state.
- CouchLoom is private to the homelab network in the VM100 deployment.
- MCP authentication uses a bearer token or the built-in OAuth flow.
- Runtime vault credentials and tokens live in mode-`0600` files outside Git.
- Write scope can be limited with `READ_ONLY` and `WRITE_FOLDERS`.
- Destructive/path-changing agent tools remain intentionally absent.
- A local Markdown folder is not automatically a CouchLoom vault; it must be
  synchronized to a configured CouchDB database or run in local-vault mode.

## Roadmap boundaries

Current product scope is retrieval plus safe note creation/editing. The next
useful integrations are an OpenClaw MCP connection, an n8n MCP/HTTP adapter,
approval-aware writes, per-vault access policy, and an operator dashboard.
Delete/move, automatic CouchDB discovery, and a second sync process are not
part of the current MVP contract.
