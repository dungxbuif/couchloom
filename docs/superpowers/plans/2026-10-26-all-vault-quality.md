# CouchLoom All-Vault Quality Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to execute and verify each task. Unchecked steps remain incomplete; health alone is not acceptance.

**Goal:** Serve both Secondbrain and Homelab through CouchLoom, preserve existing functions, and measure retrieval quality before declaring readiness.

**Architecture:** Keep Bun, MCP, CouchDB/LiveSync, PostgreSQL/pgvector and the current embedding service. Preserve `personal` as the Secondbrain vault ID; add `homelab` using its existing CouchDB source. Keep deployment and credential enrollment in `homelab-ops`, operational evidence in the Homelab vault, and app changes in this repository.

**Tech stack:** Existing Bun workspace, TypeScript, FastMCP, LiveSync, pgvector, Docker Compose, existing 1Password injection workflow.

**Spec:** The user's approved scope is configuration plus fixes, testing and deployment for both vaults, with existing functions retained. This document records implementation choices and measurable acceptance; proposed quality thresholds below are engineering targets, not observed results.

## Evidence and constraints

- Production rechecked: `couchloom:9541933`, container healthy; VM100 root has approximately 22 GiB available. Recheck immediately before deployment.
- Authenticated MCP currently lists only `personal`; its RAG inventory has 1,365 documents and 6,099 chunks. `homelab` exists in CouchDB but is not registered in CouchLoom.
- Homelab DB restricts membership to admins. Do not pass the CouchDB administrator credential to CouchLoom. CouchDB membership is not intrinsically read-only.
- Homelab has about 1.52 million CouchDB records including chunk/attachment records: this is NOT a Markdown note count. Enumerate eligible Markdown separately with bounded pagination.
- Local LiveSync settings alone do not prove current synchronization. Compare selected current Markdown contents with reconstructed CouchDB notes and document gaps before ingestion.
- Existing 12 diagnostic queries cover only three notes: unrestricted hit@5 is 6/12, folder-assisted hit@5 is 9/12. Neither proves general answer quality.
- Existing root/vault guides, human notes, unrelated worktrees, gold-price workflow and bot identity must remain intact.
- New credentials must be saved to 1Password first, then injected; mapping documents contain references and privileges, never values. Do not publish private note bodies or secret-bearing evaluation artifacts.

## Approach and alternatives

Use existing CouchDB multi-vault configuration because it preserves LiveSync and existing write behavior. A local mounted snapshot would add a second synchronization mechanism and could make writes diverge; do not silently substitute it. A database/model replacement adds migration risk without evidence of benefit; evaluate retrieval changes first using separate test data/indexes.

## Review focus

1. An absent vault must fail inventory acceptance even when registered-vault coverage is 100% (task 1).
2. Identical paths in two vaults must never cross read/write/search boundaries (tasks 2–3).
3. Failed chunk reconstruction, stale source data, or denied access must not masquerade as an empty successful index (tasks 1–2).
4. Retry/reconnect/restart must preserve changes and avoid duplicate/stale embeddings (task 3).
5. Vietnamese questions, unsupported questions and folder hints must not inflate quality claims (task 4).

## Task 1: Reproducible source and runtime inventory

**Files:** `tools/audit-vault-coverage.ts`, new `tools/audit-vault-coverage.test.ts`, `eval/README.md`; operational result in `homelab/docs/research/`.

- [x] Refine the audit to compare required IDs `personal,homelab` against configured IDs and MCP IDs and print per-configured-vault RAG counts; fail explicitly on missing IDs or tool errors. Keep infrastructure DB discovery separate from application access checks. Source/index agreement remains a later gate.
- [x] Add a self-contained test: personal-only configuration fails required-vault comparison; both IDs pass; a tool error cannot pass. Whitelist report fields and never print runtime credential objects.
- [ ] Enumerate source Markdown metadata with pagination; report scope/exclusions, checkpoint, decode failures and document counts per vault. Never use CouchDB `doc_count` as note coverage.
- [ ] Compare content hashes for selected recently changed notes in each local vault, CouchDB and RAG; report mismatches without printing note bodies. Validate representative chunked and plain notes.
- [ ] Record current MCP tool catalog, configuration fingerprints, image digest, queue state and networks as the regression baseline.

**Acceptance:** Report distinguishes source availability, registration, content freshness and indexing; absent Homelab is a failure rather than 100% success.

## Task 2: Enroll and configure Homelab through operations code

**Files:** New `automation/ansible/playbooks/couchloom-vault-enroll.yml` and secret-free vault inventory/template in `homelab-ops`; `apps/server/src/vault-config.ts` only if validation needs fixing; `deploy/vm100/compose.yml` only if mounting/injection needs fixing. Inspect current ops branch and existing credential tooling before adding either implementation.

- [ ] Discover the current 1Password injection/mapping mechanism and test access without displaying secrets. Create or reuse a dedicated application identity scoped to `homelab` using supported CouchDB APIs and preserve existing security entries.
- [ ] Store any new credential in 1Password before injection. Document item/field references, consumer, database scope, permissions, recovery and rotation procedure. Restrict deployed secret files and redact automation output.
- [ ] Confirm required read and existing note-write behavior with a dedicated test namespace. Verify the application identity cannot manage server configuration or access unrelated private databases.
- [ ] Back up deployment configuration and RAG DB; validate the backup. Render `personal` unchanged plus `homelab`; validate JSON and IDs before atomic replacement.
- [ ] Probe Homelab using an isolated process/data directory before restarting production. Bound requests and memory; record startup time, reconstruction failures and estimated index size.
- [ ] Deploy configuration through the ops playbook with one worker initially; monitor free space, backlog, failures and service responsiveness. Stop rollout if free disk drops below 5 GiB or existing personal operations regress.

**Acceptance:** MCP exposes both IDs; representative notes read correctly in each; RAG source/index inventories agree for the declared Markdown scope, backlog and failed jobs reach zero, and missing/inaccessible sources fail the deployment check.

## Task 3: Existing-function regression and recovery

**Files:** Existing `apps/server/test/e2e/{mcp,multi-vault,rag-recovery,couchdb-obfuscation,create-only-couchdb}.e2e.test.ts`, `packages/core/test/unit/`, `packages/rag/test/integration/pgvector.integration.test.ts`; fix shared implementations only where a failing test demonstrates a defect.

- [ ] Run `bun run test`, `bun run build`, `bun run test:e2e`, `bun run test:pgvector` and `bun run test:couchdb` against disposable test services; additionally run the create-only CouchDB E2E file explicitly. Record skipped prerequisites as incomplete.
- [ ] Test both vaults for list/read, folders/tags, metadata, keyword/semantic search, literal folder filters and same-path isolation. Check existing auth rejection and absence of destructive MCP tools.
- [ ] Exercise create, duplicate-create rejection, write and edit only on uniquely named test notes; verify source readback and eventual search updates. Do not modify human-authored notes or invent a delete tool for cleanup.
- [ ] Exercise queue retry, source reconnect, embedding outage and service restart in disposable services. Verify checkpoints advance only after successful processing and stale jobs cannot overwrite newer note content.
- [ ] Run an authenticated production smoke of the full applicable catalog; record latency/errors and index convergence. Verify the actual AI consumer selects both vaults and can cite retrieved notes. Track Mezon transport separately if broken; direct MCP success is not chat delivery evidence.

**Acceptance:** No unexplained regressions; source changes reach retrieval in both vaults. Existing bot/gold-price routing remains unchanged.

## Task 4: Quality measurement and evidence-led retrieval fixes

**Files:** `eval/retrieval-cases.json` remains diagnostic; add a separately reviewed private evaluation dataset. Extend `tools/rag-eval.ts` and its tests for per-case vault IDs, alternate acceptable sources and unsupported questions; candidate fixes belong in `packages/core/src/search.ts`, `packages/rag/src/{indexer,pgvector-store,openai-embeddings}.ts` only after inspecting actual failure traces.

- [ ] Build 48 evidence-labelled questions: 24 per vault, balanced Vietnamese/English, across multiple folders; include multi-note and unsupported questions. Use 32 development and 16 held-out cases; label acceptable sources and evidence passages before tuning. Keep private source material out of the public repo.
- [ ] Measure baseline per vault/language: hit@5, MRR@5, evidence recall for multi-note cases, duplicates, tool errors and p50/p95 latency. Unsupported cases are not retrieval hit-rate cases; score answer abstention at the consumer layer.
- [ ] Trace failures through source freshness, decoding, chunking, embedding inputs and ranking. Compare the smallest relevant candidate (for example keyword/vector fusion or model-prescribed query/document prefixes) on development data, using a separate index if vector semantics change.
- [ ] Select on development results, then evaluate held-out once. Report folder-assisted runs separately. Proposed gate: answerable hit@5 >=85% overall, >=80% per vault, no scope leakage/tool errors, no unsupported factual answers on unsupported cases, and p95 retrieval <=5 seconds on the recorded workload. Report actual subgroup denominators and misses; small samples do not establish universal reliability.
- [ ] Evaluate generated answers separately for claim-level evidence, source fidelity and abstention. A retrieval-only improvement must not be described as end-to-end answer correctness.

## Task 5: Deployment, evidence and rollback

- [ ] Build app images off VM100, pin the tested revision and preserve rollback image/config. Keep the existing network anchor and overlay attachments.
- [ ] Apply the reviewed ops change; rerun both-vault inventory, authenticated smoke and frozen evaluation against the deployed revision. Record image digest, config fingerprints, ops commit, data timestamp and exact commands/results.
- [ ] Update `eval/README.md` and `homelab/docs/services/couchloom.md` with verified scope and known limits; link the detailed report and secret mapping references.
- [ ] Roll back app/config if personal functions break, source access fails, backlog fails to converge or disk crosses the gate. Restore configuration without dropping either source database; model/index experiments must leave the old index usable.
- [ ] Mark completion only when all source, regression, quality and deployed-consumer gates pass. Otherwise record the failed gate and continue; do not replace it with a health check.

## Execution ledger

- 2026-10-26: Existing isolated app worktree retained; unrelated checkouts unchanged. Baseline unit run: 115 core + 3 RAG + 70 server tests pass; app build passes.
- Baseline `bun run test:e2e`: 32 pass, 0 fail in 98.48 seconds, including multi-vault isolation and durable RAG recovery against disposable dependencies. This is local regression evidence; it does not prove Homelab is configured in production. Separate pgvector, obfuscation and create-only suites remain to run for this rollout.
- Inventory checker: four tests first failed because the checker was absent, then passed. Live read-only execution exited 1 with `config=homelab; MCP=homelab`, correctly exposing incomplete registration. No production configuration changed.
- Credential prerequisite: local `op account list` reports one configured account, but `op whoami` reports account not signed in. VM100 and Pi5 do not have `op` in the SSH session PATH. Requested user unlock/sign-in without requesting secret values. Continue independent tests and inventory while awaiting authenticated injection.
- Ruling: keep registration acceptance in an operator audit instead of changing `/ready` semantics for all CouchLoom installations. Two required vault IDs belong to this deployment, not every user's app. Cost: deployment automation must invoke this gate.
- Additional regression: real disposable pgvector 3/3 pass; all CouchDB obfuscation assertions pass; explicit create-only CouchDB suite 2/2 pass (plain and obfuscated concurrent creates preserve the winning note and later human edits). No production databases were used by these suites.
- Evaluation runner now supports private external cases, per-case vault IDs, alternative acceptable sources, unscored unsupported cases, dataset fingerprint, per-vault metrics and latency percentiles. Five scoring/validation tests pass. Existing 12-case authenticated production baseline remains hit@5 0.5 and MRR@5 0.3403; measured p50 299 ms, p95 1539 ms in this run only. No retrieval quality gain claimed; reviewed multi-note labels, language slices and end-to-end answer review remain incomplete.
- Source freshness sample (read-only, reconstructing ordered plaintext chunks): Homelab `index.md` is 4,707 bytes in CouchDB vs 5,335 locally; `docs/services/couchloom.md` is 14,919 vs 15,353. Hashes differ for both. `docs/COUCHDB_OBSIDIAN_SYNC.md` matches exactly (6,727 bytes, SHA-256 `f11f742e686f878f405bfc3cccb528be1f2ed09e49da6867652ae8dfee9d89f6`). Its CouchDB ID is lowercase; uppercase direct lookup returning 404 does not establish absence. Resolve source synchronization before certifying freshness; do not overwrite either copy without conflict review.
- Existing headless LiveSync runner was located only in the dirty main checkout (`tools/livesync/livesync.sh`, untracked). It defaults to obsolete macOS paths and its `doctor`/`remote-status` commands write settings. It was read, not executed or copied over unrelated work. Its historical lock warning is not evidence of a current lock; inspect current sync state before choosing recovery.
- Third consecutive goal-turn credential check: `op whoami` still reports not signed in. Production remains `couchloom:9541933`, healthy. The operator must authenticate 1Password before credential enrollment can honor the required save-first workflow; neither a credential value in chat nor an administrator credential injected into the app is an acceptable substitute.
- Local sync observation: no exact-name `obsidian` process and no LiveSync/CouchLoom user service were found; Obsidian snap mounts are not running sync processes. Both plugin configurations have `liveSync=false`, `syncOnSave=true`, `syncOnStart=true`. This does not establish the state of other devices or prove a unique root cause. Do not mark source freshness verified until content comparisons converge after the trusted sync client runs.

## Resume checkpoint

Plan and regression/evaluation tooling are committed; production enrollment is not done. Resume by verifying `op whoami` succeeds without printing its output, locating the actual target vault/item references, saving the dedicated credential and mapping, and executing task 2 through ops code. Inspect source conflicts before running any bidirectional mirror. After two-vault enrollment and source convergence, run the private reviewed evaluation and deployed-consumer checks. Tasks 1–5 remain incomplete as a whole; no readiness claim is authorized by the current evidence.
