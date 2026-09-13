# CouchLoom Library And App Design

**Date:** 2026-09-14  
**Status:** Approved for migration  
**Upstream:** `es617/obsidian-sync-mcp` at `666cbb139cac88238ab5ffeae6a6bb6a0e2bff82`

## Goal

Refactor the current repository into a reusable Bun library and a thin app.
Later tasks will add multi-vault indexing, pgvector, and MCP features to the app
without coupling those concerns to the LiveSync implementation.

The product name is **CouchLoom**.

## Repository Shape

```text
couchloom/
├── apps/server/       # executable CouchLoom HTTP/MCP service
├── packages/core/     # reusable LiveSync vault library
├── docs/              # architecture and operating guidance
└── TASKS.md           # short delivery checklist
```

Package names:

- Library: `@couchloom/core`
- App: `@couchloom/server`
- Container and service: `couchloom`

## Migration Boundary

`@couchloom/core` owns reusable behavior and must not read environment
variables, start an HTTP server, call `process.exit`, or choose a data path.
It contains:

- LiveSync CouchDB and local filesystem backends;
- common vault interfaces and types;
- path validation and write-scope rules;
- Markdown/frontmatter/link parsing;
- metadata search index and index-change helpers;
- deep-link generation;
- a composable MCP tool-registration function.

`@couchloom/server` owns process behavior and contains:

- environment/config loading;
- backend construction;
- FastMCP server and authentication setup;
- background index catch-up/watch lifecycle;
- signal handling and periodic persistence;
- the production entry point.

The initial migration preserves upstream runtime behavior. It does not yet add
multi-vault, pgvector, embeddings, or deployment changes.

## Bun Contract

- Use Bun `1.3.14`, the version installed in the development environment.
- Root `package.json` is a private Bun workspace.
- Commit `bun.lock` and use `bun install --frozen-lockfile` after generation.
- Tests run with `bun test`.
- The server build runs through Bun-compatible TypeScript bundling.
- Production code imports `@couchloom/core` through the workspace package, not
  through relative paths that cross the package boundary.

## Public Library API

`packages/core/src/index.ts` is the only supported public entry point. It
exports:

- `VaultBackend`, `NoteInfo`, and `NoteListing`;
- `Vault`, `VaultConfig`, and `LocalVault`;
- `SearchIndex`;
- `applyIndexChange` and `deriveContent`;
- `registerTools`;
- `parseFrontmatterAndLinks`;
- `makeDeepLink`;
- `parseWriteFolders` and `isPathWritable`.

Internal stubs and LiveSync compatibility helpers are not public exports.

## Safety Requirements

- Preserve the pinned `livesync-commonlib` git submodule.
- Preserve path validation, encryption handling, obfuscation detection,
  authentication, host/origin checks, and secret-safe logging.
- Do not log note bodies or credentials.
- Do not change current tool behavior during the structural migration.
- The app-facing catalog excludes `delete_note` and `move_note`; backend
  methods remain internal for human-originated reconciliation and tests.

## Verification

Migration is complete when:

1. The original test suite passes before moving files.
2. The same tests pass from their new package locations with `bun test`.
3. `@couchloom/server` builds successfully against `@couchloom/core`.
4. Importing `@couchloom/core` has no process-start or HTTP-listen side effect.
5. The generated bundle reaches controlled invalid-config handling without
   module-resolution failures.

## Documentation Impact

During migration, update `README.md`, `docs/GUIDELINES.md`, and this design.
Later behavior tasks must update human documentation and the machine-readable
MCP/config schemas in the same commit. RelayHub documentation is unrelated and
must not be changed.
