# DiffSense

**Context-aware code review for maintainers and engineering teams.**

Reviewers often have to reconstruct how a change fits into a codebase before they can judge it. DiffSense indexes relevant repository code, retrieves context for a pull request diff, and asks an AI model to identify concrete defects with evidence on changed lines. It also turns risky changes into structured Playwright regression-test plans.

DiffSense is designed as a review aid: reviewers remain responsible for validating findings, deciding what to merge, and checking generated tests. It does not post comments to GitHub or modify repositories.

## What it does

- Indexes supported source files from a GitHub repository into PostgreSQL with pgvector embeddings.
- Reviews a diff against the code as it will be **after** the change: the full post-change text of each changed source file plus the most relevant indexed chunks. Every finding must name a concrete input that fails in the new code. Two independent review samples are combined (the configuration measured as "C7" below).
- Returns structured findings with severity, changed-file line, explanation, and suggested fix. A finding that cites a removed line is moved to the nearest added line of the same hunk. Other findings that do not point to added lines are discarded. Test-file findings are skipped unless you turn that off.
- Generates a bounded Playwright plan that asserts the **pre-change** behavior the diff alters, so the plan should pass on the base build and fail if the change ships. Plans contain browser actions and assertions, not executable model-written code. Invalid scenarios are dropped individually.
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

For private repositories, set `GITHUB_TOKEN` in `.env.local`. Indexing a pull-request URL targets the pull request's **merge-base** (the code the change applies to), and a review is refused until the index matches that commit. Indexing a repository URL uses its default branch. A pasted diff is checked against the indexed commit: a changed file is given to the model as "before this change" only if the diff's removed and context lines match it. One commit is indexed per repository at a time, so re-index before reviewing a different pull request.

## Regression tests

Choose **Generate Playwright plan** after indexing the repository and providing a diff or pull request. Optionally describe how the app under test looks (for example "signed out, feature flag X off"); the generator only asserts what that environment can show. The generated JSON plan is limited to same-origin navigation, CSS-based interactions, and assertions (visible, hidden, enabled, disabled, text, value, attribute, URL). Run it against the **base** build first and discard scenarios that fail there. Download it from the review desk and run it against your app:

```powershell
$env:DIFFSENSE_TEST_PLAN = "C:\path\to\diffsense-playwright-plan.json"
$env:PLAYWRIGHT_BASE_URL = "http://localhost:3000"
$env:CI = "1"
npm run test:e2e
```

The plan runner supports a fixed set of actions and rejects external navigation; it never evaluates generated JavaScript. Generated plans can still be wrong: in the HOLDOUT seeded-regression evaluation below, 6 of 20 breaking patches went undetected, so review a plan before relying on it. CI runs one real generated plan (`tests/fixtures/generated-plan.json`) plus responsive UI checks. To run the browser suite in containers, start Docker Desktop first, then run:

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

All runs use `gpt-4.1-mini` for review and `text-embedding-3-small` for embeddings, dated 2026-10-05. Every number comes from a committed results file, and `npm run check-results` (run in CI) recomputes or cross-checks each one. Round 2 was preregistered in [`evaluation/ROUND2.md`](evaluation/ROUND2.md) before any of its numbers existed; that file also logs the amendments made after measurement.

### Headline (HOLDOUT, one run per configuration)

| Measure | Original baseline | C4 (Round 2) | **C7 (shipped, Round 3)** |
|---|---|---|---|
| Labeled bugs found (recall) | 20/56 = 35.7% | 27/56 = 48.2% | 24/56 = **42.9%** (30.8–55.9%) |
| …found **and** correctly explained (two blind Claude judges agree) | 14/56 = 25.0% | 19/56 = 33.9% | 18/56 = **32.1%** |
| **Correct upstream fixes flagged anyway** | 20/30 = 66.7% | 23/30 = 76.7% | 13/30 = **43.3%** (27.4–60.8%) |
| Findings on correct fixes (judged real defects by both judges) | 21 (0) | 29 (0) | 16 (0) |
| **Combined precision** (bugs found ÷ all findings on buggy and correct diffs) | 46.5% | 48.2% | **60.0%** (44.6–73.7%) |

Intervals are Wilson 95%. Labeled precision alone is not informative: no finding on a non-test source file was ever scored wrong on the bug diffs, because labels cover every added source line. The **forward-fix arm** closes that gap: the real fix diffs (correct code) are reviewed too, and every finding there counts against precision.

**Why correct fixes were flagged** ([`ROUND3.md`](evaluation/ROUND3.md)). Two blind judges' notes show that 17 of C4's 29 flags on correct fixes described the bug the change *fixes* ("the old code crashed on X; this change fixes it") as if it were a defect. This narration grew once the full **pre-change** file was put in the review context. In the reversed-fix benchmark the same narration lands on the labeled bug, so it also inflated C1–C4's recall. C7 instead shows the reviewer the file **after** the change, asks it to report only defects that exist in the new code, and requires each finding to name a concrete failing input (findings the model marks as "already fixed by this change" are dropped). Two such samples are united. On HOLDOUT, "describes the fix" flags fell from 17 to 2. Paired by case, C7 flags 13 fewer and 3 more correct fixes than C4 (exact McNemar p = 0.021). Its recall difference to C4 (−3 ranges, bootstrap 95% CI −17.0% to +6.1%, p = 0.55) is within noise. A second-pass verifier (C6) was also tested on DEV and removed nothing, so it is not used.

Paired on the same 56 HOLDOUT ranges (`npm run compare-results`):

| Comparison | Both found | Only first | Only second | Recall difference (bootstrap 95% CI) | Exact McNemar p |
|---|---:|---:|---:|---|---:|
| baseline → C4 | 18 | 2 | 9 | +12.5% (+1.8% to +25.0%) | 0.065 |
| C4 → C7 | 20 | 7 | 4 | −5.4% (−17.0% to +6.1%) | 0.549 |
| baseline → C7 | 16 | 4 | 8 | +7.1% (−4.7% to +21.6%) | 0.388 |

Each HOLDOUT configuration ran once, and HOLDOUT had already been used once to diagnose C4's false alarms, so these comparisons are suggestive, not established. C7 makes two review calls per diff.

### DEV changes (three runs each, chosen and tuned on DEV)

| Config | Change | Found per run (/59) | Pooled recall | Pooled precision |
|---|---|---|---:|---:|
| Baseline | 8 retrieved chunks, exact added-line gate | 18, 17, 17 | 29.4% | 96.3% |
| C1 | + full pre-change text of changed files | 22, 23, 24 | 39.0% | 84.1% |
| C2 | C1 + prompt asks for the exact `+` line | 22, 23, 29 | 41.8% | 85.1% |
| C3 | C2, non-test files only, "do not report findings in test files" | 21, 20, 25 | 37.3% | 97.1% |
| C4 | C3 + removed-line citations remapped to the hunk's added line (re-scored from saved outputs, no new calls) | 26, 27, 32 | 48.0% | 97.7% |

Round 3 (DEV, one run each; the forward column is correct fixes flagged out of 30): C4 26 found, 16 flagged · C5 (post-change review, one sample) 23 and 22 found, 6 and 8 flagged · C6 (C5 + verifier) identical to C5 · **C7** (union of two C5 samples) 30 found, 10 flagged. Selection rule, preregistered: the fewest flagged correct fixes with recall ≥ 26/59, which picked C7.

C3 was redefined after seeing that every C1/C2 false positive was on a test file (a logged deviation). [`ERROR_ANALYSIS.md`](evaluation/ERROR_ANALYSIS.md) motivated C1 and C4. Of the baseline's 125 missed range-runs, 45 had the defect file outside the 40-file index cap and 23 were near-misses dropped by the exact-line gate. Details are in [`IMPROVEMENTS.md`](evaluation/IMPROVEMENTS.md) and [`ROUND2.md`](evaluation/ROUND2.md).

The blind audit ([`evaluation/audit/`](evaluation/audit/summary.json)) has two Claude judges per finding, without access to configuration. They agreed on whether the explanation was right for 110 of 113 matched findings. Only 35 of 66 DEV C3 matches correctly explained the defect, and 87 of 113 suggestions amounted to "restore the removed code". Because a reversed fix shows the correct code as deleted lines, part of the measured recall is the model noticing deleted code next to the bug.

### Regression-test generation (seeded regressions)

Small behavior-breaking patches to DiffSense's own credential-free UI, plus benign controls. **The patches were authored with Claude Code assistance; detection is computed by executing the generated plans.**

| Run | Generator | Protocol | Detected | False alarms on benign patches |
|---|---|---|---|---|
| Round 1, 40 patches | v1 | whole plan must pass on baseline | 1/40 = 2.5% (0.4–12.9%) | not measured |
| v1 plans replayed (post hoc) | v1 | quarantine (below) | 1/16 | not measured |
| DEV v2: the same 40 patches (already seen) | v2 | quarantine | 24/40 = 60.0% (44.6–73.7%) | not measured |
| **HOLDOUT v2: 20 new breaking + 10 benign patches** | v2 | quarantine | **14/20 = 70.0% (48.1–85.5%)** | **0/10** (0–27.8%) |

The v2 generator is told that the plan runs on the pre-change build and must assert behavior the patch changes, using strings from the removed lines. It also has state and attribute assertions, receives a description of the credential-free app (in the harness, plus an accessibility snapshot of the baseline page), and drops invalid scenarios one at a time. Under the quarantine protocol, each generated scenario runs twice on the baseline; scenarios that fail there are discarded. A patch is detected when a surviving scenario fails an assertion on the patched build. Replaying the 20 plans that v1 validation rejected through v2 validation alone would have kept 18 of them. The accessibility snapshot is harness-only; in the app, users can only describe their environment in text, so app-side detection may be lower. CI runs one real generated plan (Round-1 scenario r11, unedited) in the Docker e2e job.

### Not measured

Paired manual-vs-assisted review time and human finding comparability are **unmeasured**. No timing sessions have been run, and no human checked any finding or judgment. These are not zeros or estimates.

### Limitations

- **False alarms on correct code.** On 30 real fixes, the shipped configuration (C7) still flagged 13, and the judges found none of those 16 flags to be a real defect. Most remaining flags speculate or object to the change's intent. Treat every finding as a candidate.
- **Model-judged audits.** "Correctly explained" and "real defect" come from two Claude agents per item, not from people. Agreement was high (≥95%), but the judges may share blind spots.
- **Reconstructed diffs.** Cases reverse real fix commits. They are not the original bug-introducing pull requests; deleted lines show the correct code, and test changes are reverted too.
- **Possible memorization.** BugsJS projects and fixes are public and may be in the model's training data.
- **Label scope.** Labels cover only fixed lines in non-test source, so labeled precision cannot detect wrong findings on source files.
- **Nondeterminism and single runs.** Repeated DEV runs of one configuration differed by up to 7 found defects. Every HOLDOUT number comes from one run.
- **Small samples.** 59 and 56 labeled ranges, 30 cases per cohort, eight JavaScript projects, and 20 + 10 HOLDOUT regression patches on one app. Intervals are wide; do not generalize to other languages, repositories, or non-UI changes.
- **Post-hoc choices.** C1–C4 and generator v2 were designed after seeing DEV results; only the HOLDOUT runs are untouched by those choices. C4's remap rule was adopted from saved outputs and applied once to saved HOLDOUT outputs.

## Usage

The 2026-10-05 baseline completed 211 API calls (1,935,588 tokens). The abandoned recall-v2 experiment completed another 117 calls (1,400,865 tokens); its metrics are not reported. Everything after that used 1,273 completed calls and 8,775,937 tokens; the session cap was 1,000 calls / 10M tokens, raised by the owner to 1,300 / 13M for Round 3 ([session ledger](evaluation/ledger/session-2.json)). The blind audits and code reviews were done by Claude agents and used no OpenAI calls.

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
