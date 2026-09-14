# Local Snapshot Validation

## Purpose

Validate CouchLoom end to end against a disposable local copy of the production
Obsidian LiveSync database. The source database on Pi is read-only for this
exercise: replication is one-way and non-continuous.

## Topology

```text
Pi CouchDB obsidian_vault -- one-time replication --> local CouchDB snapshot
                                                        |
                                                        v
second local client --> add/edit/delete --> CouchLoom listener
                                            |            |
                                            v            v
                                      metadata index   pgvector
                                                           ^
                                                           |
                                                    local embeddings
```

All containers use a dedicated `couchloom-validation` network and unique names.
Only local loopback ports may be published. Credentials and copied note content
must never be committed or printed in logs.

## Safety rules

- Use a fresh local target database; never configure replication back to Pi.
- Do not enable continuous replication.
- Client mutations target only the local snapshot.
- MCP deletion remains unavailable. The delete event is produced by the second
  local client to test synchronization bookkeeping.
- Preserve the local validation volume until results are reviewed; cleanup is a
  separate explicit action.

## Verification sequence

1. Start local CouchDB and copy `obsidian_vault` with a one-shot `_replicate`.
2. Compare source and target `doc_count`/`update_seq` without exposing documents.
3. Start PostgreSQL with pgvector and a deterministic OpenAI-compatible
   embedding endpoint. This validation-only provider proves vector lifecycle
   behavior without downloading a large model; it does not measure semantic
   retrieval quality.
4. Start CouchLoom against the local snapshot and wait for `/ready`.
5. Verify vault discovery, metadata count, and semantic search.
6. Through a second LiveSync-compatible backend, create a unique Markdown note;
   verify CouchLoom metadata and vector rows appear.
7. Edit the note; verify content/hash/vector rows are replaced, not duplicated.
8. Delete the note through the second client; verify metadata and vector rows
   disappear.
9. Restart CouchLoom and verify the durable `_changes` checkpoint converges to
   the same state.
10. Record independent reviewer findings and observed counts in this document.

## Acceptance criteria

- The Pi source receives no writes.
- Local snapshot cloning completes successfully.
- Initial indexing completes without cross-vault leakage.
- Add, edit, and external delete each converge in metadata and pgvector.
- Restart does not duplicate chunks or resurrect the deleted note.
- Read/create/edit MCP tools work and delete/move tools remain absent.

## Defects found and corrected during validation

- Bun reports a text `Blob` as `text/plain;charset=utf-8`. The vendored
  LiveSync predicates compared the MIME string exactly with `text/plain`, so
  Bun-created Markdown was stored as Base64 binary content. The CouchLoom
  adapter now normalizes its outgoing text Blob to the MIME value expected by
  the upstream library. Regression coverage exercises both classification and
  Markdown chunk serialization without modifying the upstream submodule.
- A CouchDB hard tombstone has no `path` or `type`. The live watcher currently
  dropped that event, leaving stale metadata and pgvector rows. The watcher now
  builds an id-to-path map before subscribing, routes tombstones through it,
  and advances the live changes sequence for reconnect safety.

## Observed result — 2026-09-14

- One-shot replication completed with `45,232` live documents; source and
  target document-id hashes matched and both reported zero deleted documents
  at snapshot time.
- CouchLoom indexed `1,200` Markdown notes into `5,518` chunks using the local
  16-dimensional deterministic validation provider.
- A separate Bun process using the LiveSync-compatible `Vault` backend created,
  read, edited, and logically deleted a fresh Markdown note. The edit changed
  its content hash, retained one replacement chunk, and removed the old token.
  Logical deletion converged to zero document and chunk rows and remained
  deleted after restart.
- A pre-fix hard tombstone probe left one stale RAG document. The same probe
  after the watcher correction converged from one document to `0|0` document
  and chunk rows.
- MCP create and edit were independently read back by the second LiveSync
  client. MCP exposed ten tools including create/edit and no delete/move tool.
- The Pi source `update_seq` remained unchanged and no validation path existed
  on the source. All temporary validation notes and derived rows were removed
  locally after the checks.
- Full verification passed: core `103`, RAG `2`, server unit `49`, server E2E
  `31`; all builds completed successfully.

The local snapshot, pgvector data, and validation containers remain available
for review. The embedding endpoint is intentionally deterministic and is not a
production semantic-quality benchmark.
