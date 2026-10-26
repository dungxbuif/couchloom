# Retrieval evaluation

## Required vault inventory

Run `bun test tools/audit-vault-coverage.test.ts` to test the inventory gate.
Run the read-only production audit with:

```sh
ssh vm100 'docker exec -i couchloom bun -' < tools/audit-vault-coverage.ts
```

The deployment inventory requires both `personal` and `homelab` in configuration
and authenticated MCP. Missing either returns a nonzero exit status. Database
discovery denial is reported separately: `_all_dbs` access is not required for
ordinary application operation. Passing registration does not prove freshness,
complete source indexing or retrieval quality. Per-vault RAG `coverage=1` only
describes registered vaults, not the required deployment inventory.

## Diagnostic retrieval cases

The runner also accepts a private JSON array at `EVAL_CASES_FILE` (a path inside
the process running it). Each case has a unique `id`, nonempty `query`, `vaultId`
and `expected`, which is one path or an array of alternative acceptable paths:

```json
[
  {"id":"lab-01","vaultId":"homelab","query":"Where does application compute run?","expected":["index.md","docs/STACK.md"]},
  {"id":"unsupported-01","vaultId":"personal","query":"What is my unrecorded future appointment?","expected":[]}
]
```

These examples illustrate the schema, not reviewed quality labels. An empty
`expected` marks an unsupported question: it is excluded from hit@5/MRR@5 and
requires separate answer/abstention review. Returning no matches for an
answerable question counts as a miss; disabled search or malformed responses
fail the run. Alternatives mean **any one** acceptable source, not multi-note
evidence recall. Missing `vaultId` defaults to `personal` for the original
diagnostic set. Reports include a normalized dataset SHA-256, per-vault metrics,
denominators and nearest-rank p50/p95 latency. External files are never labelled
held-out or reviewed automatically. Keep private datasets and output paths out
of the public repository. Run `bun test tools/rag-eval.test.ts` for scoring tests.

`retrieval-cases.json` freezes both six-question probes from the October 26 audit.
It is a 12-case diagnostic set covering only three known notes, not a held-out
quality benchmark. Each case labels one expected source; other returned sources
may also answer it. Report known-note hit@5 and MRR@5, not answer correctness or
complete evidence recall. Do not tune against these cases and call them held-out.

Run through authenticated MCP (credentials stay in the container environment):

```sh
bun build tools/rag-eval.ts --target bun --packages external --outfile /tmp/couchloom-eval.js
ssh vm100 'docker exec -i couchloom bun -' < /tmp/couchloom-eval.js
ssh vm100 'docker exec -i -e EVAL_FOLDER=wiki couchloom bun -' < /tmp/couchloom-eval.js
```

The runner fails on transport/tool errors, missing result records, and violated
folder scope. Reports contain paths and ranks but not note bodies or tokens.
Folder-scoped results measure a different task: source location is supplied.
Never claim that a gain with `folder=wiki` improves unrestricted retrieval.

`search_notes` now accepts a literal `folder` argument. Use `list_folders` to
discover it. Trailing slashes are accepted; `%` and `_` are ordinary characters.
The filter applies before ranking, remains inside the requested vault, and
omitting it retains the existing all-vault search. Similarity scores are not
answer confidence. Read the actual notes and cite supported claims.

Next acceptance gate: 40–60 independently reviewed Vietnamese/English questions
across multiple folders, with evidence passages, alternate correct sources,
multi-note and unanswerable cases. Compare index variants separately and keep
the final test split out of tuning. Do not re-embed production in place.

## October 26 measured update

Authenticated MCP results are preserved in `results/2026-10-26-*.json`.
Before (`ae9d28c`) and after (`9541933`) unrestricted retrieval both score 6/12
known-note hit@5, MRR@5 0.3403. Explicit `folder=wiki` scores 9/12 and MRR@5
0.6111. All expected paths in this diagnostic set are in wiki, so this comparison
has source-location information and must not be generalized to all questions.

Production readiness remains coverage 1, backlog 0, failed 0. Five sampled
stored vectors matched fresh embeddings (cosine approximately 1). This does not
establish consistency for all chunks or quality for Vietnamese. The original
Vietnamese Redis case and both revised English pool/blockchain cases still miss.
Observed latency includes spikes of 2.6–3.8 seconds; no latency SLO is certified.
