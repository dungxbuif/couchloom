# CouchLoom Checklist

- [x] **1. Prepare code:** migrate upstream into Bun workspaces with
  `@couchloom/core` and `@couchloom/server`; preserve current behavior.
- [x] **2. Safe tool surface:** support read/create/edit and remove MCP
  delete/move tools.
- [x] **3. Multi-vault:** load multiple CouchDB databases from validated config
  and require `vault_id` in note tools.
- [x] **4. pgvector RAG:** chunk Markdown, create embeddings, persist vectors,
  and expose semantic search.
- [x] **5. Event indexing:** keep one durable `_changes` checkpoint per vault
  and reconcile human updates/deletions.
- [ ] **6. MCP integration:** expose authenticated Streamable HTTP MCP and
  connect the OpenClaw agent. The server is deployed and probeable; OpenClaw
  registration remains pending.
- [x] **7. VM100 rollout:** build a pinned image, deploy privately on VM100,
  verify metadata indexing and authenticated MCP, and update homelab runbooks.
  Production write-back UAT remains a separate operator check.

## Local sync foundation

- [x] **8. LiveSync CLI runner:** pin upstream `1.0.9-cli`, build the Docker
  image, and add a credential-safe optional runner for a local Obsidian vault.
- [ ] **9. Enable daemon:** wait for the remote LiveSync rebuild lock to be
  cleared by an existing trusted device, then run sync, mirror, and daemon
  verification before enabling launchd.
