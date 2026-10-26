# Retrieval evaluation

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
