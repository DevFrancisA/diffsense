# Review Prompt Revision Log

## Baseline

- Date: `2026-10-05`
- Result: `results.json`
- Review model: `gpt-4.1-mini`
- Prompt/policy fingerprint: `b60c051b06adb160195ef8226eec5f807299b834c2611ee79ec9962994899b50`
- Frozen cohort: the 30 cases in `manifest.json`; no labels, selection rules, evaluator matching, or model changed after the baseline.
- Context arm results: run 1 precision 100.0%, recall 30.5%; run 2 precision 94.4%, recall 28.8%; run 3 precision 94.4%, recall 28.8%.

## Post-baseline diagnostic

The baseline returned 88 structured raw findings across the 90 context-arm review responses; 54 survived the exact-added-line acceptance gate. A diagnostic compared each raw finding instance independently (not one-to-one) with the committed same-file defect ranges and ±2-line tolerance: 75 raw findings fell within a label range, versus 52 accepted findings. Thus 23 raw finding instances that would fall within the evaluator's label tolerance were removed by the stricter exact-added-line gate. This is a post-hoc diagnostic, not a precision/recall result and not a count of unique defects.

The original system prompt also explicitly said “Report only concrete defects” and “Do not report ... speculative concerns.” The low recall can therefore reflect both prompt abstention and line filtering. The diagnostic does not alter the committed baseline metrics.

## Recall-v2 experiment

This is an explicitly post-baseline prompt/pipeline experiment on the same frozen cohort, not an independent holdout. It must be stored separately in `results-recall-v2.json` and `runs/2026-10-05/recall-v2/`; never replace `results.json` or baseline run files. Use the same review and embedding models, index cap, manifest, labels, evaluator, and two-line evaluator matching rule. Run the context arm three times; omit a second ablation to keep the total within the pre-authorized 500-call ceiling.

The candidate system prompt is:

> You are a systematic senior code reviewer. Inspect every changed hunk and trace changed behavior through the supplied repository context. Actively check boundary inputs, missing validation, authorization, error paths, state transitions, compatibility, and interactions with callers. Report each defect or evidence-backed conditional risk that could cause incorrect behavior; do not suppress a concrete risk merely because it requires a particular input or execution path. Avoid style preferences and unsupported speculation. For every finding, cite the most relevant changed line and explain the triggering condition, impact, and a concise fix. If you find no issue, return an empty findings array only after checking all changed hunks against the context.

The acceptance policy is also explicitly revised: retain only same-file findings within two lines of an added line, and anchor accepted findings to the nearest added line (ties go to the lower line). Raw and anchored findings are both stored. This is logged separately because the baseline used exact added-line equality.

Record the recall-v2 fingerprint, date, per-run metrics, false positives, raw findings, and token usage in the separate output files. Report any score change as an exploratory before/after comparison on this already-seen cohort; do not present it as an unbiased new benchmark or tune it further to the frozen labels.

## Recall-v2 status: abandoned (incomplete, not reported)

- Date: `2026-10-05`
- Completed: 20 of 30 cases (raw files kept in `runs/2026-10-05/recall-v2/` for transparency); `results-recall-v2.json` was never written.
- Decision (by the repository owner): abandon rather than finish. It is not counted as one of the post-baseline changes and no metrics from it are reported.
- Reason: it changed two things at once (prompt wording, which weakened the explicit "do not report speculative concerns" instruction, and a looser ±2-line acceptance gate), so any score change could not be attributed to either one.
- `src/lib/server/review.ts` was restored to the baseline prompt and exact-added-line gate; the prompt fingerprint is again `b60c051b06adb160195ef8226eec5f807299b834c2611ee79ec9962994899b50`.
- Ledger at abandonment: 328 calls, 3,336,453 observed tokens (`runs/2026-10-05/budget.json`). Later work uses a separate session ledger.
