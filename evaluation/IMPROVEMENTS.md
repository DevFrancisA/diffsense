# Recall improvement experiments (DEV → HOLDOUT)

Registered before any DEV run of these changes. Every change is measured on **DEV** (`manifest.json`, the 30-case baseline cohort) only. **HOLDOUT** (`manifest-holdout.json`) is run exactly once with the final chosen configuration and once with the original baseline configuration.

## Fixed across all variants

- Models: `gpt-4.1-mini` (review) and `text-embedding-3-small` (embeddings).
- Evaluator, labels, selection rules, and the ±2-line one-to-one matching rule: unchanged.
- Acceptance gate: findings must cite an exact added line (baseline gate; not relaxed).
- The baseline prompt text is kept verbatim. A prompt change may only append, and the instruction against speculative findings stays.
- Each DEV variant runs the context arm 3 times (as the baseline did). The no-context ablation is not rerun.
- Embeddings are reused by content hash (`embedding_cache` table). This only avoids re-requesting identical inputs.
- OpenAI usage is recorded in `evaluation/ledger/session-2.json` (session cap: 1,000 calls / 10M tokens).

## Changes (cumulative; at most three)

Motivated by `ERROR_ANALYSIS.md`: of 125 missed range-runs, 45 had the defect file outside the 40-file index cap, 18 had it indexed but not retrieved, 23 were near-misses dropped by the exact-added-line gate, and none were beyond the 12,000-character retrieval query.

| ID | Variant | Change | Config |
|---|---|---|---|
| C1 | `dev-c1` | Add the full pre-change text of each changed source file (fetched at the indexed commit) to the review context, ahead of the 8 retrieved chunks | `DIFFSENSE_INCLUDE_CHANGED_FILES=true` |
| C2 | `dev-c2` | C1 + append one sentence to the review prompt telling the model to set `line` to the added (`+`) line where the defect appears (prompt revision `cite-added-line`, sha256 `0af6fef0…`) | C1 + `REVIEW_PROMPT_REVISION=cite-added-line` |
| C3 | `dev-c3` | Chosen after C1/C2 results are known, from: retrieve k=16 instead of 8, raise `MAX_INDEX_FILES`, or per-hunk retrieval. Logged here before it runs. | — |

## Choosing the final configuration (fixed now)

Among baseline, C1, C2, and C3, the final configuration is the one with the highest **mean DEV recall over its 3 runs**, subject to **mean DEV precision ≥ 90%**. Ties go to the configuration with fewer changes. Baseline DEV: mean recall 52/177 = 29.4%, mean precision 52/54 = 96.3%.

## Results log

Filled in from the committed `results-dev-*.json` files as each variant completes.

| Config | Runs: found / 59 | Predictions (3 runs) | False positives | Pooled recall | Pooled precision | Meets rule? |
|---|---|---:|---:|---:|---:|---|
| Baseline (`results.json`) | 18, 17, 17 | 54 | 2 | 52/177 = 29.4% | 52/54 = 96.3% | yes |
| C1 (`results-dev-c1.json`) | 22, 23, 24 | 82 | 13 | 69/177 = 39.0% | 69/82 = 84.1% | **no** (precision < 90%) |

Per-run C1: precision 75.9% / 88.5% / 88.9%, recall 37.3% / 39.0% / 40.7%. Session ledger after C1: 233 calls, 2,059,722 tokens.
| C2 (`results-dev-c2.json`) | 22, 23, 29 | 87 | 13 | 74/177 = 41.8% | 74/87 = 85.1% | **no** (precision < 90%) |

Per-run C2: precision 84.6% / 82.1% / 87.9%, recall 37.3% / 39.0% / 49.2%. Session ledger after C2 (shared with the regression harness): 367 calls, 3,089,501 tokens.

### Deviation: C3 amended after seeing DEV results

The preregistered C3 options (k=16, a higher index cap, per-hunk retrieval) did not target the observed precision loss. All 13 C2 false positives were findings on **test files** in the reversed fix diffs (for example, removed test cases in `test/map.test.js`). Labels cover only non-test source files (SELECTION.md), so the evaluator conservatively scores these as false positives. Including the full text of changed test files appears to invite such findings.

With the repository owner's approval, C3 was redefined **after seeing DEV false positives**:

| ID | Variant | Change | Config |
|---|---|---|---|
| C3 | `dev-c3` | C2, but full-file context includes only non-test changed files, and the prompt appends: "Focus on application source code; do not report findings in test files." (revision `cite-added-line-source-focus`, sha256 `e618f388…`; the baseline anti-speculation text is kept verbatim) | C2 + `DIFFSENSE_CHANGED_FILES_EXCLUDE_TESTS=true` + `REVIEW_PROMPT_REVISION=cite-added-line-source-focus` |

This is tuned to the benchmark's label scope (source files only). On a real project, a test-file defect is still a defect, so suppressing test findings is a product trade-off, not a free accuracy gain. The final-configuration rule above is unchanged.
| C3 (`results-dev-c3.json`) | 21, 20, 25 | 68 | 2 | 66/177 = 37.3% | 66/68 = 97.1% | yes |

Per-run C3: precision 100.0% / 100.0% / 92.6%, recall 35.6% / 33.9% / 42.4%. The C3 run stopped once at Express-3 run 3 on a Windows file-lock error while writing the ledger reservation. The reservation was never persisted and the API call never sent, and the run resumed (the ledger now retries locked renames).

### Final configuration (by the rule above)

Configurations meeting mean precision ≥ 90%: baseline (29.4% recall) and C3 (37.3% recall). **Final = C3.** C1 and C2 had higher DEV recall but fail the precision floor.

HOLDOUT is next: one context-arm run of C3 (`holdout-final`) and one of the original baseline configuration (`holdout-baseline`), each run exactly once.

## HOLDOUT (each configuration run exactly once)

`npm run compare-results` (writes `comparison.json`). Intervals are Wilson 95% score intervals on the raw counts:

| Config | Found / 56 | Predictions | FP | Recall (95% CI) | Precision (95% CI) |
|---|---:|---:|---:|---|---|
| Original baseline (`results-holdout-baseline.json`) | 20 | 22 | 2 | 35.7% (24.5%–48.8%) | 90.9% (72.2%–97.5%) |
| Final = C3 (`results-holdout-final.json`) | 25 | 25 | 0 | 44.6% (32.4%–57.6%) | 100.0% (86.7%–100.0%) |

On HOLDOUT, C3 found 5 more labeled defects than the baseline configuration (25 vs 20 of 56) with no false positives. The counts are small and the intervals overlap substantially: each configuration ran once on 30 cases, so this is consistent with an improvement but does not establish one. Run-to-run variance on DEV spanned 5 ranges for C3 (20, 21, 25 found), comparable to the HOLDOUT difference of 5.

Session ledger after HOLDOUT: 643 calls reserved, 642 completed, 4,879,594 API-reported tokens.
