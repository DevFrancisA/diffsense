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
2. Choose **Index repository context**. DiffSense selects up to 40 supported source files, skips files larger than 80 KB, chunks the source, and stores embeddings in PostgreSQL/pgvector.
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

## Data handling and deployment limits

Repository source chunks are stored in the configured PostgreSQL database. Source and diff content is sent to OpenAI for embeddings and review. GitHub and OpenAI credentials are read server-side from environment variables; do not commit `.env.local` or index code unless those data flows are approved for your repositories.

This version is intended for local use or a trusted single-operator environment. It has no sign-in, authorization, or tenant isolation, so **do not expose a shared instance to the public internet or use it for multiple users**. Add authentication and repository-level access controls before hosting it as a team service.

Other current limits: GitHub is the only repository provider; indexing is capped at 40 supported source files per run; findings are suggestions, not confirmed defects; and the app does not create GitHub review comments or apply fixes.

## Configuration

See `.env.example` for the complete list. `OPENAI_REVIEW_MODEL` defaults to `gpt-4.1-mini`; `OPENAI_EMBEDDING_MODEL` defaults to `text-embedding-3-small`. `DATABASE_URL` must point to PostgreSQL with the pgvector extension available. The API creates its table and indexes on first use.

## Checks

```powershell
npm run lint
npm run test:unit
npm run build
npm run test:e2e
```
