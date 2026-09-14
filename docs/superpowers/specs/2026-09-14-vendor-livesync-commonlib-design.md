# Vendor LiveSync Common Library Into CouchLoom

## Decision

CouchLoom will stop using `livesync-commonlib` as a Git submodule. The exact
source snapshot currently pinned at commit
`50d4ab9c1a7d4f59ab29c7555b8dfb2d69555e92` becomes ordinary source owned and
versioned by the CouchLoom repository under
`packages/core/lib/livesync-commonlib`.

This is a new import commit in CouchLoom. It does not rewrite existing
CouchLoom history and does not preserve the upstream repository's internal Git
metadata or commit graph.

## Repository migration

1. Record the current submodule commit and verify the nested worktree is clean.
2. Remove the submodule gitlink from the CouchLoom index and delete
   `.gitmodules` because it contains no other submodules.
3. Remove only the nested `.git` metadata file, leaving the checked-out source
   files in place.
4. Add the library tree as normal CouchLoom files.
5. Exclude upstream-only repository administration and generated artifacts that
   are not required to build CouchLoom: upstream GitHub configuration,
   release/build tooling, coverage/output directories, and dependency caches.
6. Retain source, licenses, package metadata required by imports, and any
   runtime assets required by the current build.

## Build contract

- Existing imports under `packages/core/lib/livesync-commonlib/src` remain
  unchanged during this migration.
- `bun install --frozen-lockfile`, unit tests, E2E tests, and the production
  Docker build must continue to succeed without `git submodule update`.
- A fresh clone of CouchLoom must contain all required LiveSync source and build
  without network access to the upstream Git repository after dependencies are
  installed.
- The imported library remains an internal implementation detail of
  `@couchloom/core`; it is not published as a separate package in this phase.

## Documentation changes

- README setup changes from `git clone --recurse-submodules` to ordinary
  `git clone` and removes the submodule requirement.
- Architecture identifies the vendored LiveSync component and its pinned
  upstream provenance.
- OpenClaw documentation adds token generation with
  `openssl rand -hex 32`, maps the same secret to server
  `MCP_AUTH_TOKEN` and client `COUCHLOOM_MCP_TOKEN`, and keeps the value outside
  Git in mode-`0600` environment files.
- The AI-readable `llms.txt` reflects the self-contained clone and token setup.

## Verification

- No gitlink entries remain: `git ls-files --stage` contains no mode `160000`.
- No nested `.git` path remains under `packages/core/lib/livesync-commonlib`.
- No `.gitmodules` file remains.
- The vendored directory is tracked as normal files and contains its license.
- Secret scanning confirms no real CouchDB, MCP, or deployment token was added.
- Core, RAG, server unit tests, server E2E tests, and the Docker build pass.
- A clean temporary clone from the local CouchLoom repository builds without a
  submodule initialization step.

## Rollback

Revert the single migration commit to restore the previous gitlink and
`.gitmodules`. No CouchDB, pgvector, or runtime data migration is involved.
