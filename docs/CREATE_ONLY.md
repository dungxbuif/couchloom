# Create a note without replacing existing content

Status: implemented locally against production8f7a8e0; not deployed.

Knowledge Hub needs an atomic create-only operation so a human edit between a
read and write cannot be replaced. Add MCP `create_note(vault_id, path, content)`
using the same authentication, READ_ONLY and WRITE_FOLDERS rules as write_note.
Existing write_note/edit_note behavior remains available.

Local storage uses exclusive file creation. CouchDB file-entry creation omits
_rev and disables forced writes after writing content-addressed chunks. Existing
entries and concurrent winners cause conflict; never retry with the winner's
revision. Failed creation must not update search/RAG as if a note was saved.
A conflict may leave unused content-addressed chunks; no user note is changed.

Verification: concurrent filesystem creation, existing/human-edited note,
CouchDB metadata request boundary, write-scope/read-only MCP behavior, full test
suite/build, and an isolated/live supported-MCP smoke after approved rollout.
Live deployment/restart remains a separate homelab operator gate.

## Compatibility source patch

A default-false `createOnly` argument is forwarded through DirectFileManipulator,
LiveSyncLocalDB and EntryManager. MetadataWrite selects a revision-free,
non-forced CouchDB create or preserves the ordinary revision-aware update path.
Retain this patch when refreshing the vendored compatibility source. Tests
exercise the emitted storage operation boundary; actual encrypted CouchDB create
and concurrent MCP smoke still require isolated/live integration verification.
An unsupported third-party backend returns a clear capability error.

## Verification evidence

Five new behavior tests pass: concurrent exclusive create, parent symlink escape,
CouchDB metadata conflict, ordinary update revision, and MCP scope/read-only.
Workspace build passes. No production container, config, credential or note
changed while implementing this extension.

## Production compatibility port — 2026-10-16

The original44f patch forked before the production RAG queue/recovery work.
Port only create-only behavior onto8f7a8e0; preserve durable jobs, acknowledgement
ordering, reconciliation, metrics, all existing tools/config and deployment
capabilities. Run original create-only tests RED on this base, then port code and
run the full production-base tests/build plus isolated image/MCP verification.
No second service or production credential/config changes in this source port.
README/llms.txt will document the new tool once implemented; rollout remains a
separate homelab operator gate with exact immutable image and rollback review.

Port verification adds a real filesystem/MCP concurrency test proving only the
winning creation reaches the durable RAG hook. Existing production RAG tests
remain in the suite. Image/native deployment proof is recorded separately by
the homelab operator packet; source tests alone do not establish live support.

Isolated CouchDB acceptance test:
`RUN_CREATE_ONLY_COUCHDB_E2E=1 CREATE_ONLY_TEST_COUCHDB_URL=http://127.0.0.1:<ephemeral-port> bun test apps/server/test/e2e/create-only-couchdb.e2e.test.ts`.
Only use the disposable local container with synthetic hub-test credentials. The
test refuses a non-loopback URL, creates random prefixed databases, and removes
only those databases. It checks real encrypted/obfuscated concurrent creation,
readback and preservation of a later human edit. Never use a production vault.

## Production-base verification — 2026-10-16

- Six create-only unit/MCP tests: RED on8f7a8e0, GREEN after the minimal port.
- Full package unit suite:114 core +3 RAG +70 server =187 passed,0 failed.
- Existing process MCP/multi-vault/durable-RAG recovery E2E:32 passed,0 failed,
  including dependency outage and worker/Postgres restart recovery.
- Real disposable CouchDB concurrent encrypted creation:2 passed,0 failed,
  with obfuscated and plain paths; later human edits remained unchanged.
- Workspace build passed. Disposable local CouchDB container/volumes cleaned.

No production image, note, configuration or credential has been changed by this
port. Local container image build and isolated MCP smoke are the next gates.
