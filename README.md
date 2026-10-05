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

The plan runner supports a fixed set of actions and rejects external navigation; it never evaluates generated JavaScript. The repository also includes a smoke plan and responsive UI checks. To run the browser suite in containers, start Docker Desktop first, then run:

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

The committed [selection protocol](evaluation/SELECTION.md) and [manifest](evaluation/manifest.json) define a 30-case cohort from BugsJS 1.0 (MIT). Cases are ordered by project and bug ID, capped at six per project, and labeled from bug-introducing diffs reconstructed by reversing the fix commit. The manifest commit predates any DiffSense model output. No third-party source files or full diffs are committed; `npm run build-dataset` regenerates diffs in the OS temp directory.

Run the retrieval ablation after configuring `.env.local` and starting PostgreSQL:

```powershell
npm run build-dataset
npm run benchmark -- --dry-run
npm run benchmark
npm run evaluate -- evaluation/results.json
```

For each case, the benchmark indexes the fixed commit, reviews the reversed diff with retrieved context three times, then reviews it once without context. Repository chunks are replaced case by case because storage is keyed only by repository. The call ledger prints estimated calls and tokens before each OpenAI batch and stops before exceeding 500 calls. Benchmark SDK retries are disabled so the call cap is enforceable. Set `DIFFSENSE_RUN_DATE=YYYY-MM-DD` to resume a run on its original date.

Raw outputs are limited to structured finding fields, model/date, and token usage. Long finding text is clipped; retrieved context is represented only by source path and content hash. Raw runs are stored under `evaluation/runs/<date>/`; aggregate per-run precision/recall and false-positive rows are written to `evaluation/results.json`. The results file is not created until all cases and arms complete.

## Results

Baseline run: **2026-10-05**, model `gpt-4.1-mini`, embedding model `text-embedding-3-small`, review prompt fingerprint `b60c051b06adb160195ef8226eec5f807299b834c2611ee79ec9962994899b50`.

The cohort is 30 bug-introducing diffs reconstructed from real fixes in [BugsJS/bug-dataset](https://github.com/BugsJS/bug-dataset) (version 1.0, MIT), across six projects, with 59 labeled defect ranges. Labels were created from each fixing commit and its first parent, reviewed and committed in `evaluation/manifest.json` before any DiffSense output. No 100-PR dataset exists; 100 was an incorrect count.

| Arm | Run | Findings | Labeled defects found | False positives | Precision | Recall |
|---|---:|---:|---:|---:|---:|---:|
| With retrieved context | 1 | 18 | 18 | 0 | 100.0% | 30.5% |
| With retrieved context | 2 | 18 | 17 | 1 | 94.4% | 28.8% |
| With retrieved context | 3 | 18 | 17 | 1 | 94.4% | 28.8% |
| No-context ablation | 1 | 14 | 13 | 1 | 92.9% | 22.0% |

Matching requires the same file and a finding line within the inclusive defect range extended by two lines on either side. The same committed evaluator rules were used for every run. Context-retrieval recall ranged from 28.8% to 30.5%; these results do **not** support the previous 80% recall claim. The no-context ablation is reported separately, not pooled with the context arm.

**Not measured:** paired manual-vs-assisted review time and human finding comparability. No timing sessions have run, so claim 2 has no measured time-saving result. **Not measured:** seeded-regression catch rate. The 40 regression patches and outcomes have not been authored or executed, so claim 3 has no catch-rate result. These are not zeros or estimates.

The baseline made 211 API calls with recorded usage; the budget ledger conservatively reserved 212 calls (one reservation had no usage response) against the 500-call ceiling. API-reported token usage was 1,935,588 total (1,917,798 input and 17,790 output). The runner recorded three independent context runs to expose model variance; this is a historical BugsJS cohort, limited to six projects, the pre-registered selection rules, and at most 40 indexed files per case. Results should not be generalized to arbitrary repositories without further evaluation.

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
npm run test:e2e
```
