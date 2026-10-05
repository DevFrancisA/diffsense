# Evaluation Guide

## BugsJS Cohort

The fixed benchmark cohort is in `manifest.json`; its pre-registered rules and candidate disposition log are in `SELECTION.md`. It contains 30 BugsJS bug IDs from six projects. The manifest records the upstream repository, all linked BugsJS report references, fixing commit, first-parent buggy commit, eligible source paths, reversed-diff defect ranges, and the index-file cap recorded at selection time.

BugsJS 1.0 reports 453 bugs across 10 projects and is MIT-licensed. The source checkout and reconstructed diffs are not copied into this repository. `npm run build-dataset` verifies the pinned metadata revision and regenerates the manifest and local diff cache before any benchmark run. Do not run it after `evaluation/results.json` or raw benchmark runs exist; the builder refuses to replace labels after results have been produced.

## Review Metrics

Each benchmark run is one arm/run pair. The same manifest labels are used for every run:

- `withContext` runs 1, 2, and 3 use the current review prompt and retrieved repository chunks.
- `withoutContext` run 1 uses the same prompt and diff with an empty context.
- Every case is indexed at its fixed commit immediately before review. Indexing replaces earlier chunks for that repository key.

Matching is one-to-one: predicted and known-defect paths must be identical, and the predicted line must fall in the inclusive known range extended by two lines on each side. Legacy `{file,line}` labels are interpreted as a one-line range with the same tolerance. Extra predictions are false positives. Each run reports aggregate precision, recall, false-positive count, and per-pull-request rows.

Reproduce the generated benchmark metrics with one command:

```powershell
npm run evaluate -- evaluation/results.json
```

The benchmark writes the run's structured findings and raw token usage under `runs/<date>/`, and only paths plus SHA-256 hashes for retrieved context chunks. Model output text is limited to structured finding fields; explanation and suggestion fields are clipped to at most three lines and 500 characters. No prompt context, chunk body, full diff, credential, or `.env` file is written to the repository.

The runner prints estimates before each OpenAI request batch, persists a budget ledger, disables SDK retries, and stops before reserving more than 500 OpenAI calls. Token estimates are approximate; response usage reported by the API is stored alongside them. GitHub source retrieval calls are separate from this OpenAI call budget.

## Baseline Results

Run date: `2026-10-05`. Review model: `gpt-4.1-mini`. Embedding model: `text-embedding-3-small`. The manifest SHA-256 is stored in `results.json`; the review prompt SHA-256 is `b60c051b06adb160195ef8226eec5f807299b834c2611ee79ec9962994899b50`.

| Arm | Run | Predictions | Correct | False positives | Precision | Recall |
|---|---:|---:|---:|---:|---:|---:|
| With context | 1 | 18 | 18 | 0 | 100.0% | 30.5% |
| With context | 2 | 18 | 17 | 1 | 94.4% | 28.8% |
| With context | 3 | 18 | 17 | 1 | 94.4% | 28.8% |
| Without context | 1 | 14 | 13 | 1 | 92.9% | 22.0% |

The context arm's recall range is 28.8%–30.5%; its precision range is 94.4%–100.0%. Do not average away the repeated-run variance or combine the ablation with the context arm. The cohort has 30 cases and 59 known defect ranges.

## Human Review Time

No manual findings or paired timing observations exist yet. The paired timing study is not implemented or run. Therefore, manual/assisted defect comparison and median review-time savings are unmeasured, and the evaluator returns `null` for missing human-review metrics rather than treating missing observations as zero. The planned human tasks use these same 30 BugsJS cases. Do not add timing rows until actual paired observations are collected.

## Seeded Regressions

The definition above was fixed before any scenario ran and is applied by `scripts/regressions.ts` as written in [`regressions/PROTOCOL.md`](regressions/PROTOCOL.md). That file records three harness restarts, none of which changed a scenario outcome.

Result (`regressions/results.json`, checked by `npm run check-results`): **1 detected of 40 valid scenarios (2.5%); 1 of 2 valid plans.** 38 plans were invalid: 24 were rejected by the generator's own validation, and 14 failed on the unmodified baseline. One scenario was not detected, and one was replaced by a reserve after Chromium failed to launch. The patches were authored with Claude Code assistance; detection is computed by execution.

## Post-baseline work

- `ERROR_ANALYSIS.md`: classification of every missed range in the baseline context runs.
- `SELECTION.md` § HOLDOUT and `manifest-holdout.json`: the second cohort, registered before any run on it.
- `IMPROVEMENTS.md`: DEV changes C1–C3, the preregistered selection rule, the logged C3 deviation, and the single HOLDOUT run of each configuration with Wilson 95% intervals (`comparison.json`).
- `PROMPT-REVISIONS.md`: the abandoned, unreported recall-v2 experiment.
- Usage after the baseline is in `ledger/session-2.json` (session cap 1,000 calls / 10M tokens). The 500-call per-date ledger in `runs/2026-10-05/budget.json` covers only the baseline and recall-v2.

## Empty and synthetic data

An empty evaluation has `null` precision, recall, timing, and regression rates. `tests/fixtures/synthetic-metrics-smoke.json` exists only to exercise the CLI calculations; it is synthetic and must not be mixed into BugsJS results or described as model performance.

## Round 2

Preregistration, amendments, and definitions: [`ROUND2.md`](ROUND2.md). Outputs:

- R1 (remap rule, config C4): `results-dev-c4.json`, `results-holdout-baseline-remap.json`, `results-holdout-final-c4.json`, re-scored with `npm run rescore` from saved raw findings (no new calls).
- R2 (false alarms on correct code): `falsealarms-holdout-forward-*.json`; source/test precision split, paired McNemar, and bootstrap in `comparison.json` (`npm run compare-results`).
- R3 (shipping): the app reviews with C4 through `src/lib/server/review-pipeline.ts`, the same builder the benchmark uses. `scripts/verify-changed-files.ts` confirms the later pre-change check keeps every measured file.
- R4–R6 (plan generator v2, protocol v2): `regressions/replay-validation-v2.json`, and `regressions/v2/` (scenarios, patches, runs, plans, `results-{replay-v1,dev,holdout}.json`).
- R7 (blind audit) and the judgments of forward-fix flags: `audit/` (`key.json`, `judgments.json`, `summary.json`). Judges are Claude agents, not people.

## Round 3

[`ROUND3.md`](ROUND3.md): why correct fixes were flagged (the reviewer narrated the fix when shown pre-change files), the candidates C5–C7, the selection rule, and the HOLDOUT results. Outputs: `results-dev-c5*.json`, `results-dev-c6.json`, `results-dev-c7.json`, `results-holdout-c5*.json`, `results-holdout-c7.json`, and the `falsealarms-*-c4/c5/c6/c7*.json` files (C7 files built by `scripts/union-runs.ts`, C6 by `scripts/verify-run.ts`). Blind judgments are in `audit/key-r3.json`, `audit/judgments-r3.json`, and `audit/summary-r3.json`. `scripts/check-apply-diff.ts` confirms that applying each diff reproduces the post-change files exactly (250 files).
