# CouchLoom Development Guidelines

CouchLoom turns the original `obsidian-sync-mcp` code into a reusable library
plus an always-on app.

## Boundaries

- `packages/core` is reusable library code and has no environment or process
  side effects.
- `apps/server` composes configuration, MCP transport, authentication, workers,
  and lifecycle.
- Only `packages/core/src/index.ts` defines the library's public API.
- Keep the LiveSync submodule pinned and record its commit when syncing
  upstream.

## Working Rules

- Use Bun `1.3.14` for install, tests, and builds.
- Write a failing test before changing behavior.
- Keep vault, indexing, vector storage, embeddings, and MCP behind focused
  interfaces.
- Never commit or log credentials, passphrases, bearer tokens, or note bodies.
- Update human docs and machine-readable schemas with the behavior they
  describe.
- Finish each checklist objective with passing tests and a focused commit.

## MVP Safety

- Agents may read, create, and edit notes.
- Agents may not delete or move notes.
- Do not add a configuration escape hatch for agent delete/move during MVP.
- A human deletion in Obsidian may remove the corresponding derived RAG rows.
- MCP remains private to the homelab network for the first deployment.
