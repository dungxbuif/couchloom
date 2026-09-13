# CouchLoom Checklist

- [x] **1. Prepare code:** migrate upstream into Bun workspaces with
  `@couchloom/core` and `@couchloom/server`; preserve current behavior.
- [x] **2. Safe tool surface:** support read/create/edit and remove MCP
  delete/move tools.
- [ ] **3. Multi-vault:** load multiple CouchDB databases from validated config
  and require `vault_id` in note tools.
- [ ] **4. pgvector RAG:** chunk Markdown, create embeddings, persist vectors,
  and expose semantic search.
- [ ] **5. Event indexing:** keep one durable `_changes` checkpoint per vault
  and reconcile human updates/deletions.
- [ ] **6. MCP integration:** expose authenticated Streamable HTTP MCP and
  connect the OpenClaw agent.
- [ ] **7. VM100 rollout:** build a pinned image, deploy privately on VM100,
  verify indexing/write-back, and update homelab runbooks.
