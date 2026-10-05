# DiffSense

**Context-aware code review for maintainers and engineering teams.**

Reviewers often have to reconstruct how a change fits into a codebase before they can judge it. DiffSense indexes relevant repository code, retrieves context for a pull request diff, and asks an AI model to identify concrete defects with evidence on changed lines. It also turns risky changes into structured Playwright regression-test plans.

DiffSense is designed as a review aid: reviewers remain responsible for validating findings, deciding what to merge, and checking generated tests. It does not post comments to GitHub or modify repositories.

## What it does

- Indexes supported source files from a GitHub repository into PostgreSQL with pgvector embeddings.
- Retrieves nearby repository context before asking OpenAI to review a diff.
- Returns structured findings with severity, changed-file line, explanation, and suggested fix. Findings that do not point to added diff lines are discarded.
- Generates a bounded Playwright plan from the diff and retrieved context. Plans contain browser actions and assertions, not executable model-written code.
- Calculates review-quality and workflow metrics from a labeled evaluation dataset you provide.

## Try it locally

### Requirements

- Node.js 24 or newer
- Docker Desktop with Compose
- An OpenAI API key
- A GitHub token for private repositories or higher API rate limits (optional for public repositories)

### Start the app

```powershell
Copy-Item .env.example .env.local
```

Add `OPENAI_API_KEY` to `.env.local`, then start PostgreSQL and the Next.js app:

```powershell
docker compose up -d postgres
npm ci
npm run dev
```

Open `http://localhost:3000`. The sample diff can be loaded without credentials; indexing and AI actions require the configured services.

### Review a change

1. Enter a GitHub repository or pull request URL.
2. Choose **Index repository context**. DiffSense selects up to `MAX_INDEX_FILES` supported source files (40 by default), skips files larger than 80 KB, chunks the source, and stores embeddings in PostgreSQL/pgvector.
3. Paste a unified diff or use a pull request URL, then choose **Analyze change**.
4. Inspect the candidate findings and verify them against the code before acting.

For private repositories, set `GITHUB_TOKEN` in `.env.local`. Indexing a pull-request URL targets its head commit; indexing a repository URL uses its default branch. Re-index after the source changes to refresh the stored snapshot.

## Regression tests

Choose **Generate Playwright plan** after indexing the repository and providing a diff or pull request. The generated JSON plan is limited to same-origin navigation, CSS-based interactions, and assertions. Download it from the review desk and run it against your app:

```powershell
$env:DIFFSENSE_TEST_PLAN = "C:\path\to\diffsense-playwright-plan.json"
$env:PLAYWRIGHT_BASE_URL = "http://localhost:3000"
$env:CI = "1"
npm run test:e2e
```

The plan runner supports a fixed set of actions and rejects external navigation; it never evaluates generated JavaScript. Generated plans are often invalid: in the seeded-regression evaluation below, 38 of 40 plans were unusable, so review a plan before relying on it. CI runs one real generated plan (`tests/fixtures/generated-plan.json`) plus responsive UI checks. To run the browser suite in containers, start Docker Desktop first, then run:

```powershell
docker compose --profile test up --build --abort-on-container-exit --exit-code-from e2e e2e
docker compose --profile test down
```

## Evaluate review quality

Meaningful precision, recall, review-time, and regression-catch metrics need a representative labeled set. Keep defect labels independent of model output, define the cohort and matching rules before evaluating, and compare manual and assisted reviews of the same changes.

The evaluator accepts one JSON file:

```json
{
  "pullRequests": [
    {
      "id": "pr-001",
      "knownDefects": [{ "file": "src/auth.ts", "line": 42 }],
      "manualFindings": [{ "file": "src/auth.ts", "line": 42 }],
      "assistedFindings": [{ "file": "src/auth.ts", "line": 42 }],
      "manualMinutes": 18,
      "assistedMinutes": 11
    }
  ],
  "regressionScenarios": [{ "id": "scenario-001", "detected": true }]
}
```

Run it with:

```powershell
npm run evaluate -- path/to/results.json
```

Precision and recall compare assisted findings with labeled defects; file paths must match and line numbers may differ by at most two. Review-time savings are calculated per paired pull request, with the median percentage change reported. Regression catch rate is the fraction of seeded scenarios marked detected. Empty datasets produce `null` rates rather than invented scores.

For a CLI smoke test, run `npm run evaluate -- tests/fixtures/synthetic-metrics-smoke.json`. That fixture is deliberately synthetic and verifies the calculations; its output is not a benchmark of DiffSense.

## BugsJS benchmark

DiffSense is evaluated on bugs from **BugsJS 1.0** ([BugsJS/bug-dataset](https://github.com/BugsJS/bug-dataset), MIT license):

> Péter Gyimesi, Béla Vancsics, Andrea Stocco, Davood Mazinanian, Árpád Beszédes, Rudolf Ferenc, and Ali Mesbah. "BugsJS: a Benchmark of JavaScript Bugs." *12th IEEE International Conference on Software Testing, Verification and Validation (ICST)*, 2019.

No BugsJS or upstream source is committed. `npm run build-dataset` regenerates the diffs in the OS temp directory from the pinned dataset revision.

Two cohorts are defined by the committed [selection protocol](evaluation/SELECTION.md). Each was committed before any DiffSense output on it.

- **DEV** ([`manifest.json`](evaluation/manifest.json)): 30 cases, 59 labeled defect ranges, six projects. It was used for the baseline and for choosing improvements.
- **HOLDOUT** ([`manifest-holdout.json`](evaluation/manifest-holdout.json)): 30 further cases selected with the same rules, 56 ranges. It was run once per configuration.

Each case is a bug-introducing diff reconstructed by **reversing the real fix commit**. Labels are the added lines on the buggy side, restricted to non-test source files. A finding matches a label when the file is the same and the line falls within the range ±2 lines (one-to-one matching).

```powershell
npm run build-dataset                                    # DEV (refuses after results exist)
$env:DIFFSENSE_COHORT = "holdout"; npm run build-dataset # HOLDOUT (refuses to overwrite)
npm run benchmark -- --dry-run                           # prints call/token estimates
npm run evaluate -- evaluation/results.json              # recompute metrics from committed results
npm run check-results                                    # CI gate: schema + stored-vs-recomputed metrics
npm run compare-results                                  # DEV vs HOLDOUT table with Wilson 95% intervals
npm run error-analysis                                   # classify every missed range (no API calls)
```

Benchmark variants are set by environment variables (`DIFFSENSE_BENCHMARK_VARIANT`, `DIFFSENSE_MANIFEST`, `DIFFSENSE_RUNS`, `DIFFSENSE_INCLUDE_CHANGED_FILES`, `DIFFSENSE_CHANGED_FILES_EXCLUDE_TESTS`, `REVIEW_PROMPT_REVISION`, `DIFFSENSE_RETRIEVAL_K`, `MAX_INDEX_FILES`). Each variant's exact configuration is stored in its results file. OpenAI usage is metered in [`evaluation/ledger/session-2.json`](evaluation/ledger/session-2.json); the ledger prints an estimate before every batch and refuses any batch that would exceed the session cap. Raw outputs contain only structured finding fields (clipped), token usage, and path + SHA-256 references for context.

## Results

All runs use `gpt-4.1-mini` for review and `text-embedding-3-small` for embeddings, dated 2026-10-05. Numbers come from the committed results files; reproduce them with the commands shown.

### Review accuracy: baseline (DEV)

`npm run evaluate -- evaluation/results.json`. Prompt `b60c051b…`, 8 retrieved chunks, 40-file index cap.

| Arm | Run | Findings | Labeled defects found | False positives | Precision | Recall |
|---|---:|---:|---:|---:|---:|---:|
| With retrieved context | 1 | 18 | 18 / 59 | 0 | 100.0% | 30.5% |
| With retrieved context | 2 | 18 | 17 / 59 | 1 | 94.4% | 28.8% |
| With retrieved context | 3 | 18 | 17 / 59 | 1 | 94.4% | 28.8% |
| No-context ablation | 1 | 14 | 13 / 59 | 1 | 92.9% | 22.0% |

### Why recall is low

[`ERROR_ANALYSIS.md`](evaluation/ERROR_ANALYSIS.md) is a post-hoc diagnostic over the baseline context runs. Of 125 missed range-runs:

- 45 had the defect file outside the 40-file index cap.
- 39 were wrong-line findings, 23 of them near-misses dropped by the exact-added-line gate.
- 23 had the defect file retrieved, but the model stayed silent.
- 18 had the file indexed but not retrieved.
- None fell beyond the 12,000-character retrieval query.

### Improvements tried on DEV, checked on HOLDOUT

Three cumulative changes were tried on DEV ([`IMPROVEMENTS.md`](evaluation/IMPROVEMENTS.md)). Each ran 3 times. The final configuration was chosen by a rule preregistered before any DEV run: highest pooled recall with pooled precision ≥ 90%.

| DEV config | Found per run (/59) | Pooled recall | Pooled precision |
|---|---|---:|---:|
| Baseline | 18, 17, 17 | 29.4% | 96.3% (52/54) |
| C1: add full pre-change text of changed files | 22, 23, 24 | 39.0% | 84.1% (69/82) |
| C2: C1 + prompt asks for the exact `+` line | 22, 23, 29 | 41.8% | 85.1% (74/87) |
| **C3**: C2 with only non-test files' full text + "do not report findings in test files" | 21, 20, 25 | 37.3% | 97.1% (66/68) |

C3 was redefined after seeing that every C1/C2 false positive was a finding on a test file, which BugsJS labels do not cover. This deviation is logged. Suppressing test-file findings fits this benchmark's label scope and is a product trade-off, not a free gain.

HOLDOUT, each configuration run **once** (`npm run compare-results`, Wilson 95% intervals):

| HOLDOUT config | Found / 56 | Predictions | FP | Recall (95% CI) | Precision (95% CI) |
|---|---:|---:|---:|---|---|
| Original baseline | 20 | 22 | 2 | 35.7% (24.5–48.8%) | 90.9% (72.2–97.5%) |
| Final (C3) | 25 | 25 | 0 | 44.6% (32.4–57.6%) | 100.0% (86.7–100.0%) |

The counts are small. With one run per configuration and overlapping intervals, HOLDOUT is consistent with an improvement but does not establish one; C3's DEV run-to-run spread (20–25 found) is as large as the HOLDOUT difference. C3 is a benchmark configuration: the app's review endpoint still uses the baseline pipeline. The app indexes a pull request's head commit, so wiring in "full pre-change file text" needs a base-commit fetch that has not been built.

### Regression-test generation (seeded regressions)

[`evaluation/regressions/`](evaluation/regressions/PROTOCOL.md) holds 40 valid seeded scenarios: small behavior-breaking patches to DiffSense's own credential-free UI. **The scenarios were authored with Claude Code assistance; detection is computed by execution.**

For each scenario, the app's real plan generator (`/api/tests/generate` logic) produced a Playwright plan from the patch diff using context indexed from the pushed base commit. The plan then ran twice on the baseline build and once on the patched build. A scenario counts as detected only if the plan passes on baseline both times and an assertion step fails on the patch.

| Measure | Value |
|---|---|
| Detected / valid scenarios | **1 / 40 (2.5%)** |
| Detected / valid plans | 1 / 2 |
| Invalid plans | 38: 24 rejected by the generator's own validation (13 missing an expected value, 10 with an off-origin `goto`, 1 with more than 12 steps), 14 failed on the unmodified baseline |
| Not detected | 1 (plan passed on the patched app) |
| Scenarios replaced for infrastructure failure | 1 (Chromium failed to launch) |

`npm run check-results` validates `evaluation/regressions/results.json` against the per-scenario records. The finding is that plan generation, not execution, is the bottleneck: most generated plans are malformed or encode the patched behavior rather than the baseline behavior. CI runs one real generated plan (scenario r11, unedited) in the Docker e2e job.

### Not measured

Paired manual-vs-assisted review time and human finding comparability are **unmeasured**. No timing sessions have been run. These are not zeros or estimates.

### Limitations

- **Reconstructed diffs.** Cases reverse real fix commits. They are not the original bug-introducing pull requests, and the reversed diffs also revert test changes.
- **Possible memorization.** BugsJS projects and fixes are public and may be in the model's training data. This could inflate every configuration's scores and cannot be ruled out here.
- **Conservative false positives.** Labels cover only the fixed lines in non-test source. A finding about a real issue elsewhere (including in tests) is scored as a false positive.
- **Nondeterminism.** Repeated DEV runs of one configuration differed by up to 7 found defects (C2: 22 vs 29). HOLDOUT ran once per configuration.
- **Small samples.** 59 and 56 labeled ranges, 30 cases per cohort, eight JavaScript projects in total. Confidence intervals are wide. Do not generalize to other languages or repositories without further evaluation.
- **Post-hoc choices.** C1–C3 were chosen using DEV results, and C3 was amended after seeing DEV false positives. Only HOLDOUT is untouched by those choices.
- **Seeded regressions** are small single-file UI patches written for this harness, all on one app; 2.5% detection says nothing about larger or non-UI changes.

## Usage

The 2026-10-05 baseline completed 211 API calls (1,935,588 tokens). The abandoned recall-v2 experiment completed another 117 calls (1,400,865 tokens); its metrics are not reported. Everything after that (regression harness, DEV C1–C3, HOLDOUT) used 642 completed calls and 4,879,594 tokens ([session ledger](evaluation/ledger/session-2.json)).

## Data handling and deployment limits

Repository source chunks are stored in the configured PostgreSQL database. Source and diff content is sent to OpenAI for embeddings and review. GitHub and OpenAI credentials are read server-side from environment variables; do not commit `.env.local` or index code unless those data flows are approved for your repositories.

This version is intended for local use or a trusted single-operator environment. It has no sign-in, authorization, or tenant isolation, so **do not expose a shared instance to the public internet or use it for multiple users**. Add authentication and repository-level access controls before hosting it as a team service.

Other current limits: GitHub is the only repository provider; indexing is capped at `MAX_INDEX_FILES` supported source files per run (40 by default); findings are suggestions, not confirmed defects; and the app does not create GitHub review comments or apply fixes.

## Configuration

See `.env.example` for the complete list. `OPENAI_REVIEW_MODEL` defaults to `gpt-4.1-mini`; `OPENAI_EMBEDDING_MODEL` defaults to `text-embedding-3-small`; `MAX_INDEX_FILES` defaults to `40`. `DATABASE_URL` must point to PostgreSQL with the pgvector extension available. The API creates its table and indexes on first use.

## Checks

```powershell
npm run lint
npm run test:unit
npm run build
npm run check-results
npm run test:e2e
```
