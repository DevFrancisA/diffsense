# Evaluation Guide

## BugsJS cohort

The fixed benchmark cohort is in `manifest.json`; its pre-registered rules and candidate disposition log are in `SELECTION.md`. It contains 30 BugsJS bug IDs from six projects. The manifest records the upstream repository, all linked BugsJS report references, fixing commit, first-parent buggy commit, eligible source paths, reversed-diff defect ranges, and the index-file cap recorded at selection time.

BugsJS 1.0 reports 453 bugs across 10 projects and is MIT-licensed. The source checkout and reconstructed diffs are not copied into this repository. `npm run build-dataset` verifies the pinned metadata revision and regenerates the manifest and local diff cache before any benchmark run. Do not run it after `evaluation/results.json` or raw benchmark runs exist; the builder refuses to replace labels after results have been produced.

## Review metrics

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

## Human review time

No manual findings or paired timing observations exist yet. The paired timing study is not implemented or run. Therefore, manual/assisted defect comparison and median review-time savings are unmeasured, and the evaluator returns `null` for missing human-review metrics rather than treating missing observations as zero. The planned human tasks use these same 30 BugsJS cases. Do not add timing rows until actual paired observations are collected.

## Seeded regressions

No regression patches or outcomes exist yet. The predeclared target is 40 valid seeded scenarios. A scenario counts as **detected** if and only if its generated Playwright plan passes on the unmodified baseline app in two runs and that same plan fails on the patched app with an assertion failure on one of the plan's own steps.

A plan that passes on the patch or fails on the baseline is not detected; baseline failures count as invalid plans separately. Server startup failures, build failures, and navigation timeouts are infrastructure-invalid, not detections. Replace infrastructure-invalid scenarios until 40 valid scenarios exist and report the replacement count. The two headline rates are detected / 40 scenarios and detected / valid plans. Outcomes must come only from executing each generated plan against baseline and patched applications; no outcomes are present until then.

## Empty and synthetic data

An empty evaluation has `null` precision, recall, timing, and regression rates. `tests/fixtures/synthetic-metrics-smoke.json` exists only to exercise the CLI calculations; it is synthetic and must not be mixed into BugsJS results or described as model performance.
