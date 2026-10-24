# CouchLoom

CouchLoom is a Bun-based, multi-vault knowledge service for Obsidian
Self-hosted LiveSync. It reconstructs Markdown from CouchDB, maintains an
event-driven pgvector index, and exposes safe Streamable HTTP MCP tools to AI
agents such as OpenClaw.

The MCP write surface intentionally supports create and edit, but never delete
or move.

## Repository layout

- `packages/core` — reusable LiveSync backends, metadata index, vault registry,
  MCP note tools, and the vendored LiveSync compatibility source.
- `packages/rag` — deterministic Markdown chunking, OpenAI-compatible
  embeddings, and vault-scoped pgvector storage.
- `apps/server` — configuration, lifecycle, authentication, HTTP health, and
  Streamable HTTP MCP runtime.
- `deploy/vm100` — private VM100 Compose deployment with pgvector and Ollama.
- `docs` — architecture, configuration, security, OpenClaw, and operations.

## Capabilities

- Multiple vaults, with one stable `vault_id` per CouchDB database.
- Explicit multi-vault configuration; CouchDB databases are not auto-discovered.
- Durable CouchDB `_changes` checkpoints and automatic re-indexing.
- MCP becomes available after metadata indexing; pgvector backfill continues
  in the background on first deployment.
- LiveSync chunk reconstruction, including supported E2E-encrypted vaults.
- Semantic search filtered by one or more vault IDs.
- Authenticated Streamable HTTP MCP at `/mcp`.
- Liveness at `/health` and dependency readiness at `/ready`.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `list_vaults` | Discover configured vault IDs and names |
| `list_folders` | List vault folders and note counts |
| `list_tags` | List tags and counts |
| `list_notes` | Filter and sort notes |
| `read_note` | Read Markdown by path |
| `get_note_metadata` | Read frontmatter, tags, links, and backlinks |
| `search_notes` | Search the pgvector index by semantic similarity |
| `get_index_status` | Inspect per-vault metadata/RAG state |
| `write_note` | Create or replace a Markdown note |
| `edit_note` | Append, prepend, or replace exact text |

Every note tool requires `vault_id`. `delete_note` and `move_note` are not
registered.

## Local development

Requirement: Bun 1.3.14. The repository is self-contained; no submodule setup
is required.

```bash
git clone git@github.com:dungxbuif/couchloom.git
cd couchloom
bun install --frozen-lockfile
bun run test
bun run build
```

Run with either a local vault or a CouchDB vault. Multi-vault deployments should
use a config file:

```bash
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
VAULTS_CONFIG_FILE=/absolute/path/vaults.json \
bun run dev
```

Store `MCP_AUTH_TOKEN` in a mode-`0600` environment file for persistent use;
do not commit its value. OpenClaw receives the same secret as
`COUCHLOOM_MCP_TOKEN`; see [`docs/OPENCLAW.md`](docs/OPENCLAW.md).

See [`docs/vaults.schema.json`](docs/vaults.schema.json) and
[`docs/MULTI_VAULT.md`](docs/MULTI_VAULT.md) for the exact schema.

For headless local Markdown mirroring, the optional upstream LiveSync CLI
runner is documented in [`docs/LOCAL_LIVESYNC.md`](docs/LOCAL_LIVESYNC.md).
The VM100 production service uses the vendored LiveSync common library directly
against CouchDB; it does not run a second CLI sync node.

## RAG configuration

RAG starts when `DATABASE_URL` is set. Required variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection with pgvector available |
| `EMBEDDING_BASE_URL` | OpenAI-compatible base URL |
| `EMBEDDING_MODEL` | Embedding model name |
| `EMBEDDING_DIMENSIONS` | Vector dimension matching the model |

Optional tuning variables are `RAG_CHUNK_CHARS` (default `1800`) and
`RAG_CHUNK_OVERLAP` (default `200`). Changing vector dimensions on an existing
database requires a planned index rebuild.

## VM100 production

The production profile is portless and attaches only CouchLoom itself to the
existing `homelab-net` overlay. PostgreSQL and Ollama remain on a private
internal network.

```bash
docker compose \
  -f deploy/vm100/compose.yml \
  --env-file /opt/apps/couchloom/run/.env \
  up -d --build
```

OpenClaw connects internally to `http://couchloom:8787/mcp` using a bearer
token. See [`docs/VM100_RUNBOOK.md`](docs/VM100_RUNBOOK.md) and
[`docs/OPENCLAW.md`](docs/OPENCLAW.md).

The VM100 RAG deployment uses Ollama `nomic-embed-text` with 768-dimensional
embeddings. Ollama runs CPU-only and is capped at `2.0` vCPU to protect the
Proxmox host during backfill; GPU passthrough is not currently configured, so
embedding throughput is intentionally limited.

To add another vault, sync it to a dedicated CouchDB database, add one
validated object to the runtime `vaults.json`, restart only CouchLoom, and
verify it with `list_vaults`, `get_index_status`, and `search_notes`. See
[`docs/MULTI_VAULT.md`](docs/MULTI_VAULT.md).

## Safety and source of truth

CouchDB is always the source of truth. pgvector rows are derived and may be
rebuilt. Keep vault credentials and MCP tokens outside Git, prefer
`VAULTS_CONFIG_FILE`, and set secret files to mode `0600`.

Architecture and policy details:

- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`docs/APP_DESIGN.md`](docs/APP_DESIGN.md)
- [`docs/MULTI_VAULT.md`](docs/MULTI_VAULT.md)
- [`docs/RAG_ARCHITECTURE.md`](docs/RAG_ARCHITECTURE.md)
- [`docs/SAFE_TOOL_SURFACE.md`](docs/SAFE_TOOL_SURFACE.md)
- [`SECURITY.md`](SECURITY.md)

## License

MIT. CouchLoom derives from
[`obsidian-sync-mcp`](https://github.com/es617/obsidian-sync-mcp) and uses
[`livesync-commonlib`](https://github.com/vrtmrz/livesync-commonlib). Its
LiveSync compatibility source is vendored under
`packages/core/lib/livesync-commonlib` from upstream commit
`50d4ab9c1a7d4f59ab29c7555b8dfb2d69555e92` and retains the upstream license.
