# Vendor LiveSync Common Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `livesync-commonlib` Git submodule with ordinary source fully owned and versioned by CouchLoom.

**Architecture:** Preserve the currently pinned upstream source at its existing import path, remove only submodule/Git administration state and upstream-only artifacts, then track the runtime source directly in the parent repository. Keep public behavior and TypeScript import paths unchanged.

**Tech Stack:** Git, Bun 1.3.14, TypeScript, Docker

**Spec:** `docs/superpowers/specs/2026-09-14-vendor-livesync-commonlib-design.md`

## Global Constraints

- Preserve upstream commit provenance `50d4ab9c1a7d4f59ab29c7555b8dfb2d69555e92` in documentation.
- Do not rewrite existing CouchLoom history.
- Do not retain nested `.git` metadata or a mode-`160000` gitlink.
- Preserve the upstream license and all runtime source/assets required by `@couchloom/core`.
- Do not commit credentials, tokens, caches, generated output, or dependency directories.

---

### Task 1: Convert the submodule to owned source

**Files:**
- Delete: `.gitmodules`
- Delete: `packages/core/lib/livesync-commonlib/.git`
- Modify index entry: `packages/core/lib/livesync-commonlib`
- Retain: `packages/core/lib/livesync-commonlib/LICENSE`

**Interfaces:**
- Consumes: current gitlink pinned at `50d4ab9c1a7d4f59ab29c7555b8dfb2d69555e92`
- Produces: normal tracked files at the same source path

- [x] **Step 1: Capture the pre-migration invariant**

Run:

```bash
rtk git submodule status
rtk git ls-files --stage packages/core/lib/livesync-commonlib
rtk git -C packages/core/lib/livesync-commonlib status --short
```

Expected: pinned SHA above, mode `160000`, and a clean nested worktree.

- [x] **Step 2: Remove the gitlink without deleting the worktree**

Run:

```bash
rtk git rm --cached packages/core/lib/livesync-commonlib
```

Expected: only the parent index entry is removed; files remain on disk.

- [x] **Step 3: Remove submodule metadata**

Use `apply_patch` to delete `.gitmodules`. Remove the exact nested metadata file
`packages/core/lib/livesync-commonlib/.git`; do not recursively target a parent
directory.

- [x] **Step 4: Exclude upstream-only repository files**

Remove upstream `.github`, dependency caches, coverage/build output and release
tooling only after confirming they are not imported by CouchLoom's build. Keep
`src`, `LICENSE`, package/TypeScript metadata, and required runtime assets.

- [x] **Step 5: Add and verify ordinary files**

Run:

```bash
rtk git add packages/core/lib/livesync-commonlib .gitmodules
rtk git ls-files --stage packages/core/lib/livesync-commonlib | head
rtk git ls-files --stage | awk '$1 == "160000" { print }'
```

Expected: regular file modes under the library and no `160000` entries.

### Task 2: Update setup, provenance, and token documentation

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/OPENCLAW.md`
- Modify: `llms.txt`

**Interfaces:**
- Consumes: self-contained source tree from Task 1
- Produces: human and agent-readable clone/token setup

- [x] **Step 1: Update clone instructions**

Replace the submodule requirement and `git clone --recurse-submodules` with an
ordinary clone. State that LiveSync compatibility source is vendored at
`packages/core/lib/livesync-commonlib` from the pinned upstream SHA.

- [x] **Step 2: Document token generation and mapping**

Add this exact generation command:

```bash
openssl rand -hex 32
```

Document that the same secret is stored as `MCP_AUTH_TOKEN` for CouchLoom and
`COUCHLOOM_MCP_TOKEN` for OpenClaw, in mode-`0600` environment files outside
Git. Keep the existing `streamable-http` configuration and probe command.

- [x] **Step 3: Update the AI-readable surface**

Update `llms.txt` so an agent knows a normal clone is sufficient, how the token
is generated/mapped, and that delete/move remain unavailable.

### Task 3: Verify the self-contained repository

**Files:**
- Verify: entire repository

**Interfaces:**
- Consumes: Tasks 1–2
- Produces: reproducible migration commit

- [x] **Step 1: Check repository invariants and secrets**

Run checks for `.gitmodules`, nested `.git`, mode `160000`, generated folders,
and known credential patterns. Expected: none, except documented placeholders.

- [x] **Step 2: Run the complete test and build suite**

Run in the pinned Bun container:

```bash
bun run test
bun run test:e2e
bun run build
docker build -t couchloom:vendor-validation .
```

Expected: all commands exit zero.

- [x] **Step 3: Verify a clean clone without submodules**

Create a temporary clone from the local repository, confirm the vendored source
and license are present, and run the production Docker build without any
submodule command. Remove only that exact temporary clone afterward.

- [x] **Step 4: Commit the migration**

```bash
git add -A
git commit -m "refactor: vendor LiveSync common library"
```

Expected: one CouchLoom commit contains the gitlink removal, imported source,
documentation, and verification-ready repository state.
