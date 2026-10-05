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
