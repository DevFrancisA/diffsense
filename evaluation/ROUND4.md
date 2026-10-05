# Round 4: stronger models, sampling and voting, and an untouched TEST cohort (preregistration)

Written and committed before any Round-4 model call. The evaluator, labels, matching rule, and acceptance rule (exact added line or remapped removed-line citation) are unchanged. The repository owner raised the session cap to **2,500 calls**. The token cap is raised proportionally to **25M** (an assumption, stated to the owner). Round 4 starts at 1,274 calls and 8,775,937 tokens.

## Data

- **Development set:** DEV + HOLDOUT, 60 cases. That is 115 labelled ranges on the bug-introducing (reversed) diffs, and 60 correct forward fixes. Both cohorts have already been used, so they are now development data only.
- **TEST** (`manifest-test.json`, 30 cases, 80 ranges, committed in `269e58d` before any run): run **once** at the end, with the chosen configuration and with C7 as the reference.

## Metrics

- **Recall:** labelled ranges found ÷ ranges.
- **Combined precision:** ranges found ÷ every accepted finding on both the reversed and the forward diffs. Every finding on a correct fix counts as wrong.
- **Selection objective:** **combined F1**, the harmonic mean of recall and combined precision.
- Also reported:
  - correct fixes flagged ÷ fixes;
  - labelled precision;
  - Wilson 95% intervals;
  - paired comparisons against C7 on TEST.

## Phases (DEV + HOLDOUT unless stated)

- **A. Model screen.** The C5 pipeline (post-change files and prompt, remap acceptance), one sample per diff on both arms, with:
  - `gpt-5.4-mini`;
  - `gpt-5.5`.

  Existing `gpt-4.1-mini` C5 samples (two per diff, both arms, both cohorts) are reused as the reference. About 240 calls.
- **B. Sampling and voting.** For the model with the best combined F1 in phase A, two more samples per diff on both arms (three in total; about 240 calls). Every rule "keep a finding seen in ≥ k of n samples" (n ≤ 3; a finding's identity is file and line) is then scored offline. The same rules are scored for `gpt-4.1-mini` with n = 2.
- **C. Verifier (optional).** Run only if the best phase-B rule still flags at least 20% of correct fixes. The C6 verifier with the phase-A winner as its model, applied to that rule's findings (about 80 calls).
- **Selection (fixed now).** Among every configuration measured in phases A–C, including C7, choose the highest development-set combined F1. Ties (within 0.01) go to fewer model calls per diff. The chosen configuration's model, sample count, vote threshold, and verifier use are then frozen.
- **D. TEST, once.** The chosen configuration and C7 are run on TEST, both arms. Any further change after TEST results is reported as post-hoc and never re-measured on TEST.

## Budget estimate

| Phase | Calls |
|---|---:|
| A | ~240 |
| B | ~240 |
| C | ~80 |
| D: chosen config, up to 3 samples × 60 diffs | ≤180 |
| D: C7, 120 | 120 |
| D: TEST indexing and query embeddings | ~180 |
| **Total** | **≈1,040** of the 1,226 remaining |

Two blind Claude judges (no OpenAI calls) audit TEST findings with the Round-2 rubric.

## Execution log

- **Phase A, attempt 1 (interrupted).** A shell loop overwrote its positional parameters, so all but the first run per model were sent with a manifest file name as the model name. Those calls failed with HTTP 404 before producing anything. Their run directories, which held no outputs, were deleted. The two correctly configured runs are kept:
  - `dev-m54mini`: complete, `gpt-5.4-mini`, 27/59 found on DEV reversed;
  - `dev-m55`: 18 of 30 cases complete and resumable, `gpt-5.5`.
- **Stopped: the OpenAI account ran out of credits** (HTTP 429 "no credits remaining") at 1,329 reserved calls / 9,211,326 tokens. No further runs are possible until credits are added.
- No phase-A result has been used for any decision yet. The forward (false-alarm) arm has not run for either new model.
- **Phase A, attempt 2.** Resumed after credits were added. A transient "fetch failed" during indexing was retried. Complete:
  - `gpt-5.4-mini`: both arms on DEV and HOLDOUT;
  - `gpt-5.5`: DEV both arms, HOLDOUT reversed.
- **Stopped again: credits ran out** (HTTP 429) after `holdout-forward-m55` had completed 29 of 30 cases. Ledger: 1,522 reserved / 1,512 completed calls, 11,187,334 tokens.
- **Interim DEV scores, one sample each** (no decision taken; the development set is incomplete for `gpt-5.5`):

  | Model | Found / 59 | Correct fixes flagged / 30 | Combined precision | Combined F1 |
  |---|---:|---:|---:|---:|
  | `gpt-4.1-mini` ×2 (C7) | 30 | 10 | 66.7% | 0.577 |
  | `gpt-5.4-mini` ×1 | 27 | 20 | 56.3% | 0.505 |
  | `gpt-5.5` ×1 | 31 | 11 | 70.5% | 0.602 |
- **Owner decision (cost):** phases B (extra `gpt-5.5` samples and voting) and C (verifier) are **skipped**. Selection uses the preregistered rule over the configurations actually measured: every `gpt-4.1-mini` C5 rule with n ≤ 2 (C7 included), `gpt-5.4-mini` n=1, and `gpt-5.5` n=1. The winner is chosen by development-set combined F1 after the last `gpt-5.5` HOLDOUT case completes. Phase D then runs on TEST once: the winner, plus C7 as the reference.
- **Selection (development set, DEV + HOLDOUT, `npx tsx scripts/vote-analysis.ts`):** the winner is **`gpt-5.5`, one sample**: 63/115 found (54.8%), combined precision 76.8%, combined F1 **0.640**, 17/60 correct fixes flagged. C7 (`gpt-4.1-mini`, union of 2) scores 54/115, 63.5%, F1 0.540, 23/60; `gpt-5.4-mini` ×1 scores F1 0.526. The configuration is frozen as the C5 pipeline with `OPENAI_REVIEW_MODEL=gpt-5.5` and one sample, called **C8**. TEST runs next, once, for C8 and for C7.

## TEST results (run once; `npx tsx scripts/vote-analysis.ts test`)

| TEST (30 cases, 80 ranges) | Found (recall, Wilson 95%) | Findings (bug / correct) | Combined precision (Wilson 95%) | Combined F1 | Correct fixes flagged |
|---|---|---|---|---:|---|
| C7 (`gpt-4.1-mini`, union of 2) | 28 (35.0%, 25.5–45.9%) | 28 / 27 | 50.9% (38.1–63.6%) | 0.415 | 15/30 |
| **C8 (`gpt-5.5`, 1 sample)** | **31 (38.8%, 28.8–49.7%)** | 33 / 10 | **72.1% (57.3–83.3%)** | **0.504** | **10/30** |

- **Bugs found, paired by range:** both 19, C7 only 9, C8 only 12; exact McNemar p = 0.664.
- **Correct fixes flagged, paired by case:** both 8, C7 only 7, C8 only 2; p = 0.180.
- Neither paired difference is statistically significant on TEST alone. The direction matches the development set (F1 0.640 vs 0.540).
- Recall is lower on TEST than on the development set for both configurations, so TEST appears harder (it includes a new project, Pencilblue).
- **Cost:** C8 makes one `gpt-5.5` call per review, roughly $0.08; C7 makes two `gpt-4.1-mini` calls, roughly $0.008 in total.
- **Session ledger:** 1,806 reserved / 1,796 completed calls, 14,174,043 tokens.
