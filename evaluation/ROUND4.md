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
