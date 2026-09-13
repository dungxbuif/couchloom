# CouchLoom Bun Workspace Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the cloned single-package Node project into a Bun workspace containing reusable `@couchloom/core` and thin `@couchloom/server` packages without changing runtime behavior.

**Architecture:** Reusable vault, parsing, metadata-index, write-scope, deep-link, and MCP tool-registration modules move into `packages/core`. Environment parsing, authentication, HTTP transport, background worker lifecycle, and the executable entry point move into `apps/server`. The pinned LiveSync submodule moves with the core package.

**Tech Stack:** Bun 1.3.14, TypeScript, FastMCP, PouchDB, tsup, Self-hosted LiveSync commonlib.

**Spec:** `docs/superpowers/specs/2026-09-14-couchloom-library-app-design.md`

## Global Constraints

- Preserve behavior during this migration; multi-vault, pgvector, embeddings, and tool removal are later tasks.
- Keep `livesync-commonlib` pinned at `50d4ab9c1a7d4f59ab29c7555b8dfb2d69555e92`.
- Use Bun 1.3.14 for dependency installation, tests, builds, and runtime smoke checks.
- Do not commit secrets, generated runtime data, or `node_modules`.
- Import app functionality only from the public `@couchloom/core` entry point.

---

### Task 1: Establish The Bun Baseline

**Files:**
- Modify: `package.json`
- Create: `bun.lock`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: unchanged upstream source and tests.
- Produces: reproducible Bun dependency and test baseline.

- [ ] **Step 1: Install upstream dependencies with Bun**

Run: `bun install`

Expected: `bun.lock` is created and dependency installation exits `0`.

- [ ] **Step 2: Run the unchanged test suite under Bun**

Run: `bun test`

Expected: all upstream unit tests pass before files move. If Bun exposes a real compatibility failure, record the failing boundary and fix it with a test before proceeding.

- [ ] **Step 3: Convert the root manifest into a private workspace**

Set the root manifest to this contract:

```json
{
  "name": "couchloom",
  "private": true,
  "version": "0.1.0",
  "packageManager": "bun@1.3.14",
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "test": "bun test",
    "build": "bun run --cwd packages/core build && bun run --cwd apps/server build",
    "start": "bun run --cwd apps/server start",
    "dev": "bun run --cwd apps/server dev"
  }
}
```

- [ ] **Step 4: Reinstall and verify the workspace manifest**

Run: `bun install && bun test`

Expected: install succeeds; tests still pass before structural moves.

- [ ] **Step 5: Commit the baseline**

```bash
git add package.json bun.lock .gitignore
git commit -m "build: establish CouchLoom Bun workspace"
```

### Task 2: Extract `@couchloom/core`

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/tsup.config.ts`
- Create: `packages/core/src/index.ts`
- Move: `src/{deeplink,id-format,index-sync,parse,search,tools,vault-backend,vault-local,vault,write-scope}.ts` and matching tests to `packages/core/src/`
- Move: `src/stubs/` to `packages/core/src/stubs/`
- Move: `lib/livesync-commonlib/` to `packages/core/lib/livesync-commonlib/`
- Modify: `.gitmodules`

**Interfaces:**
- Consumes: upstream reusable modules.
- Produces: side-effect-free public entry point `@couchloom/core`.

- [ ] **Step 1: Write the failing public-import test**

Create `packages/core/src/index.test.ts`:

```ts
import { expect, test } from "bun:test";

test("core imports without terminating or starting a server", async () => {
  const core = await import("./index");
  expect(typeof core.Vault).toBe("function");
  expect(typeof core.registerTools).toBe("function");
  expect(typeof core.SearchIndex).toBe("function");
});
```

Run: `bun test packages/core/src/index.test.ts`

Expected: FAIL because the public entry point does not exist.

- [ ] **Step 2: Move reusable modules and the pinned submodule**

Use `git mv` for tracked files and update `.gitmodules` path to
`packages/core/lib/livesync-commonlib`. Update `vault.ts` and the core build
aliases to resolve the new local submodule path.

- [ ] **Step 3: Add the public entry point**

`packages/core/src/index.ts` must export the exact public API listed in the
design spec and no app module.

- [ ] **Step 4: Add the core package manifest and build**

The package is named `@couchloom/core`, is ESM, exports `dist/index.js` and
`dist/index.d.ts`, and provides `build` and `test` scripts driven by Bun.

- [ ] **Step 5: Verify the core package**

Run: `bun test packages/core/src && bun run --cwd packages/core build`

Expected: moved unit tests pass; `dist/index.js` and declarations are created.

- [ ] **Step 6: Commit the core extraction**

```bash
git add .gitmodules packages/core src lib
git commit -m "refactor: extract reusable CouchLoom core library"
```

### Task 3: Create The Thin Server App

**Files:**
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/tsup.config.ts`
- Move: `src/{auth,host-guard,main}.ts` and matching tests to `apps/server/src/`
- Move: `test/` to `apps/server/test/`
- Modify: imports in `apps/server/src/main.ts`

**Interfaces:**
- Consumes: `@couchloom/core` public exports.
- Produces: `@couchloom/server` executable and HTTP MCP service.

- [ ] **Step 1: Write the failing app boundary test**

Create `apps/server/src/core-boundary.test.ts`:

```ts
import { expect, test } from "bun:test";
import * as core from "@couchloom/core";

test("server consumes the core public package", () => {
  expect(typeof core.registerTools).toBe("function");
  expect(typeof core.applyIndexChange).toBe("function");
});
```

Run: `bun test apps/server/src/core-boundary.test.ts`

Expected: FAIL until the workspace dependency and app package exist.

- [ ] **Step 2: Move app modules and change imports**

Move authentication, host guarding, entry point, and app integration tests.
Replace cross-boundary relative imports with `@couchloom/core` imports.

- [ ] **Step 3: Add app package and build configuration**

Name the package `@couchloom/server`, depend on `@couchloom/core` with
`workspace:*`, and expose `dist/main.js`. Build the ESM server for the Bun
runtime and preserve the existing browser-global compatibility shim.

- [ ] **Step 4: Verify the app**

Run: `bun test apps/server/src apps/server/test && bun run build`

Expected: all tests and both package builds pass.

- [ ] **Step 5: Verify controlled startup failure**

Run: `env -u VAULT_PATH -u COUCHDB_URL bun apps/server/dist/main.js`

Expected: exits nonzero with the existing safe message requiring `VAULT_PATH`
or `COUCHDB_URL`, with no module-resolution error.

- [ ] **Step 6: Commit the app extraction**

```bash
git add apps/server src test package.json bun.lock
git commit -m "refactor: compose CouchLoom server from core"
```

### Task 4: Reconcile Packaging And Documentation

**Files:**
- Modify: `README.md`
- Modify: `Dockerfile`
- Modify: `.env.example`
- Modify: `server.json`
- Modify: `TASKS.md`
- Modify: `docs/GUIDELINES.md`

**Interfaces:**
- Consumes: working Bun workspace.
- Produces: documented development and packaging flow.

- [ ] **Step 1: Update human-facing docs**

Document the CouchLoom name, workspace layout, `bun install`, `bun test`,
`bun run build`, and the fact that behavior is still upstream-compatible after
this migration.

- [ ] **Step 2: Update machine-readable packaging**

Keep `server.json` aligned with the server endpoint and environment contract.
Update the Dockerfile to build and run the workspace with Bun 1.3.14.

- [ ] **Step 3: Mark checklist objective 1 complete**

Only check Task 1 in `TASKS.md`; later feature objectives remain unchecked.

- [ ] **Step 4: Run final verification**

Run: `bun install --frozen-lockfile && bun test && bun run build && git diff --check`

Expected: every command exits `0` and the working tree contains only intended
documentation/packaging changes.

- [ ] **Step 5: Commit the migration documentation**

```bash
git add README.md Dockerfile .env.example server.json TASKS.md docs package.json bun.lock
git commit -m "docs: document CouchLoom workspace"
```

