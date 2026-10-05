# Round 3: why correct fixes get flagged, and the fix (preregistration)

Written and committed before any Round-3 model call. Evaluator, labels, cohorts, and matching rule are unchanged. The repository owner raised the session cap to **1,300 calls / 13M tokens** (`ledger/session-2.json`). At the start of Round 3, 881 calls and 6,118,371 tokens had been used.

## Diagnosis (from saved outputs, no API calls)

The final configuration (C4) flagged 23 of 30 correct HOLDOUT fixes (29 findings), and the two blind judges agreed that none of the 29 was a real defect. Their notes put each flag into one category (`audit/judgments.json`):

| Category | C4 (29 flags) | Baseline (21 flags) |
|---|---:|---:|
| Describes the bug that the change **fixes**, or recommends exactly what the diff already does | 17 | 3 |
| Objects to the fix's intended behavior, or speculates without a failing case | 8 | 13 |
| Misreads the new code, or a style/naming concern | 4 | 5 |

The "describes the fix" failure grew sharply once the **full pre-change file** was added to the context (C1–C4). Shown the old code next to the diff, the model narrates the change ("previously X crashed; this change fixes it") and files that narration as a finding on the added line. In the reversed-fix benchmark, narrating the change happens to land on the labelled bug, so part of the C1–C4 recall gain is this same behavior. This also fits the R7 audit, where 87 of 113 matched findings suggested restoring the removed code.

## Candidates (DEV only)

- **C5: judge the code after the change.**
  - The full text of each changed non-test source file is given **after** the change: the pre-change file with the diff applied, used only when the diff applies to it. It is labelled "(full file after this change)". The 8 retrieved chunks are unchanged.
  - The prompt (revision `post-change`) keeps the baseline text verbatim and appends three instructions:
    - judge the code as it is after the change;
    - report a defect only if it exists after the change and the change introduced or exposed it;
    - never report a problem the change fixes, never restate what the change does, and never object to the change's evident intent without a concrete failing input.
  - Each finding must also return `failureAfterChange` (a concrete input or state that misbehaves in the new code) and `alreadyFixedByChange` (boolean). Findings with `alreadyFixedByChange = true` or an empty `failureAfterChange` are dropped. The remaining findings pass through C4's acceptance rule (exact added line, or a removed-line citation remapped).
- **C6: C5 plus a verifier.** One extra call per diff that has accepted findings. The verifier sees the diff, the post-change files, and the findings. It keeps a finding only if the finding describes a defect present in the code after the change. It rejects findings that describe the problem the change fixes, restate the change, object to intent without a concrete failure, are style, or are speculation. C6 is computed by running the verifier on C5's saved outputs, so C5 and C6 share their generation runs.

## Measurements

- **DEV reversed (bugs):** C5, one run. C6 is derived from it. The reference is C4's three DEV runs (26, 27, 32 found of 59).
- **DEV forward (correct fixes):** C4, C5, and C6 on the real DEV fix diffs (`git diff <buggy> <fix>`, indexed at `<buggy>`), one run each.
- **Combined precision:** labelled ranges found / (accepted findings on the reversed diffs + accepted findings on the forward diffs). Each correct-fix flag counts as a wrong finding. This is reported together with recall and the per-case false-alarm rate.

## Selection rule (fixed now)

Among C4, C5, and C6, choose the configuration with the **fewest DEV forward cases flagged**, provided its DEV reversed recall is at least **26/59** (C4's lowest DEV run). Ties go to higher DEV recall, then fewer model calls. If C5 and C6 both fail the recall floor, C4 stays.

## HOLDOUT (run once)

Run the chosen configuration once on HOLDOUT, reversed and forward. Compare it with the existing HOLDOUT C4 results (`results-holdout-final-c4.json`, `falsealarms-holdout-forward-final.json`). HOLDOUT has already been used once to confirm C4 and to diagnose its false alarms, so it is **not untouched** for the forward arm. Its results are reported with that caveat. The two blind Claude judges are reused for "correctly explained" and "real defect", labelled as model-judged.

## Budget estimate

| Step | Calls |
|---|---:|
| DEV forward indexing and query embeddings | ~60 |
| Reviews: C4 forward, C5 reversed, C5 forward | 90 |
| Verifier (C6) on DEV | ~50 |
| HOLDOUT reviews | 60 |
| HOLDOUT verifier, if C6 is chosen | ~50 |
| **Total** | **~310 calls, ~3M tokens** |

The ledger refuses any batch that would pass 1,300 calls or 13M tokens.

## DEV results (logged before any further run)

| DEV | Reversed: found / 59 (run 1) | Forward: cases flagged / 30 | Forward findings | Combined precision |
|---|---:|---:|---:|---:|
| C4 | 26 (runs 2-3: 27, 32) | 16 | 22 | 26/48 = 54.2% |
| C5 | 23 | **6** | 9 | 23/32 = 71.9% |
| C6 | 23 | 6 | 9 | 23/32 = 71.9% |

- The verifier kept every C5 finding on both arms, so C6 had no effect.
- C5 cut DEV false-alarm cases from 16 to 6 but **fails the recall floor** (23 < 26).
- Under the rule above, **C4 stays** among C4–C6.
- C5 produced only 26 raw findings on the reversed diffs. Its `alreadyFixedByChange` filter dropped just 2 findings near a label. So the recall loss comes from the model reporting less, not from the filter.

## C7 (added after the DEV results above; registered before it runs)

- **C7** = C5 sampled **twice** per diff. The accepted findings of the two samples are united, removing duplicates by file and line.
- The second sample is a fresh one-run C5 variant (`dev-c5-r2`, `dev-forward-c5-r2`). C5's own eligibility still uses its preregistered run 1.
- C7 joins the candidate set under the **same selection rule**: the fewest DEV forward cases flagged, with DEV reversed recall ≥ 26/59.
- Cost: about 60 DEV calls, and about 120 on HOLDOUT if C7 is chosen (two samples on each arm).

## C7 on DEV, and selection

| DEV | Reversed found / 59 | Forward cases flagged / 30 | Forward findings |
|---|---:|---:|---:|
| C5 sample 2 (`dev-c5-r2`) | 22 | 8 | 12 |
| **C7** = union of C5 samples 1 and 2 | **30** | **10** | 15 |

Under the selection rule, only C4 (16 flagged, recall 26) and C7 (10 flagged, recall 30) clear the recall floor. **C7 is selected.** It makes two review calls per diff, where C4 makes one. A C4 union of two samples was not measured on the forward arm, so part of C7's recall gain over a single C4 run may come from sampling twice.

## HOLDOUT results (C7, run once; HOLDOUT was already used once to diagnose C4, see above)

`npm run compare-results`. Intervals are Wilson 95%.

| HOLDOUT | Bugs found / 56 | Correct fixes flagged / 30 | Findings on correct fixes | Combined precision | Correctly explained (both judges) |
|---|---:|---:|---:|---:|---:|
| Original baseline | 20 (35.7%) | 20 (66.7%) | 21 | 46.5% (32.5–61.1%) | 14 (25.0%) |
| C4 (Round 2) | 27 (48.2%) | 23 (76.7%) | 29 | 48.2% (35.7–61.0%) | 19 (33.9%) |
| **C7 (Round 3)** | **24 (42.9%)** | **13 (43.3%)** | **16** | **60.0% (44.6–73.7%)** | **18 (32.1%)** |

- **False alarms, C4 → C7 (paired by case):** 13 cases stop being flagged and 3 start being flagged. Exact McNemar p = 0.021, so this reduction is statistically significant.
- **Bugs found, C4 → C7 (paired by range):** 7 ranges are found only by C4 and 4 only by C7. The difference is −5.4%, bootstrap 95% CI −17.0% to +6.1%, McNemar p = 0.549, so the change is not significant.
- **Bugs found, baseline → C7:** +7.1% (CI −4.7% to +21.6%, p = 0.388).
- **Flags on correct fixes, judged by two blind Claude agents:** 0 of 16 were judged real defects, and the judges agreed on all 16. The targeted failure, describing the fix as if it were a bug, fell from 17 of 29 flags (C4) to 2 of 16 (C7). The remaining flags mostly object to the fix's intent or speculate (10).
- **Matched findings:** 18 of 24 correctly explain the bug (judges agreed on 23 of 24).
- **Cost:** C7 makes two review calls per diff, where C4 makes one.

**Conclusion.** C7 roughly halves false alarms on correct code and raises combined precision from 48% to 60%. Recall is about level with C4 (24 vs 27 of 56; the difference is within noise) and above the original baseline. It still flags 13 of 30 correct fixes. The app now ships C7.

**Session ledger at the end of Round 3:** 1,274 of 1,300 calls, 8,775,937 of 13M tokens.
