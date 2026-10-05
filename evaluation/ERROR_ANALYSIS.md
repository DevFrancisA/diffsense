# Recall error analysis (baseline context arm)

Post-hoc diagnostic of the committed 2026-10-05 baseline (`results.json`, prompt `b60c051b…`, `gpt-4.1-mini`, DEV cohort of 30 cases / 59 defect ranges). It reads only saved outputs and makes no OpenAI calls. It does not change any metric.

Reproduce:

```powershell
npm run error-analysis    # writes evaluation/error-analysis.json
```

The script reruns the evaluator's one-to-one matching to find which ranges each run missed. It checks that its match counts equal those in `results.json` (18 / 17 / 17) and stops if they differ.

## Classification rule

Each missed (range, run) pair gets the first category that applies:

1. **Wrong line**: the model raised something about this range but at a line the evaluator could not score:
   - a nearby (±2) raw finding was dropped by the exact-added-line acceptance gate, or
   - a nearby accepted finding had already been matched to an adjacent range (one-to-one matching), or
   - an *unmatched* finding exists in the same file more than 2 lines away.
2. **Outside index cap**: no finding targets this range, and the defect file was not among the files the 40-file cap admitted. The admitted set is rebuilt from the GitHub tree at the indexed commit with the indexer's own filter; its size is checked against `filesIndexed`.
3. **Not retrieved**: the file was indexed, but none of the 8 retrieved chunks came from it.
4. **Retrieved but silent**: at least one chunk of the defect file was retrieved, and the model reported nothing targeting this range.

Caveats:

- The changed lines are always in the diff the model sees. "Not retrieved" and "outside cap" mean the surrounding file context was missing, not that the defect lines were hidden.
- Retrieval is judged by file path only. Chunks come from the pre-change commit, so whether a chunk covered the exact lines is not established.
- Rule refinement: the first pass counted *any* same-file finding more than 2 lines away as "wrong line". Many of those findings had been matched to a different range in the same file, so they target that range, not this one. The rule above excludes them. Both versions are reported; the change was made before any improvement experiment and does not touch the evaluator.

## Results (125 missed range-runs = 41 + 42 + 42)

| Category | Refined rule | First-pass rule |
|---|---:|---:|
| Outside index cap | **45** (36%) | 25 |
| Wrong line | **39** (31%) | 78 |
| ↳ nearby finding rejected by exact-added-line gate | 23 | 23 |
| ↳ nearby finding consumed by adjacent range | 3 | 3 |
| ↳ unmatched finding >2 lines away in same file | 13 | 52 (any same-file finding) |
| Retrieved but silent | **23** (18%) | 12 |
| Not retrieved | **18** (14%) | 10 |

Per run (refined): run 1: cap 14, wrong-line 14, silent 8, not-retrieved 5. Run 2: 17 / 10 / 8 / 7. Run 3: 14 / 15 / 7 / 6.

Unique ranges: 54 of the 59 were missed in at least one run; 27 were missed in all three. Of the 54, 20 had their file outside the index cap in at least one miss. Those 20 come from 8 cases: Eslint-5, Eslint-6, Express-2, Express-3, Express-6, Hexo-3, Hexo-5, and Karma-3. The indexer keeps the first 40 eligible files in tree order, so central files such as Express's `lib/response.js` can be dropped while earlier paths in the tree fill the cap.

The 12,000-character retrieval query cut-off did not hide any missed range: all 125 misses start within the first 12,000 characters of their diff.

## What this suggests (not yet measured)

- The largest share of misses comes from defect files that were never indexed (36%). Indexing the changed files themselves addresses this directly; raising the cap does so only indirectly.
- About a fifth of misses (23) are near-misses removed by the exact-added-line gate. Changing the gate is an acceptance-policy change, so it would have to be reported as one.
- Per-hunk retrieval is not motivated by truncation, because no miss fell past the query cut-off.
- These categories are a post-hoc diagnostic on the same cohort used to choose improvements. Any improvement must be confirmed on the held-out cohort.
