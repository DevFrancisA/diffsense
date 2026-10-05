# DiffSense

DiffSense is a context-aware pull request review workspace. It indexes GitHub source files into PostgreSQL/pgvector, retrieves relevant chunks for a diff, asks OpenAI for structured findings, and checks that every finding points to an added line. It can also generate constrained Playwright regression plans and run them through a fixed action runner.

Evaluation values in the interface start blank on purpose. Precision, recall, review-time savings, and regression catch rate must come from a blind-labeled corpus and paired runs; the app does not claim the resume targets as measured results.

## Requirements

- Node.js 24 or newer
- Docker Desktop with Compose
- An OpenAI API key
- A GitHub token for private repositories or higher API rate limits (optional for public repositories)

## Run locally

```powershell
Copy-Item .env.example .env.local
docker compose up -d postgres
npm install
npm run dev
```

Add `OPENAI_API_KEY` to `.env.local`. The local database URL in the example matches the Compose PostgreSQL service. Open `http://localhost:3000`.

Paste a repository or pull request URL and choose **Index repository context**. Indexing selects up to 40 source files (each at most 80 KB), chunks them, creates `text-embedding-3-small` embeddings, and replaces that repository's previous indexed snapshot. Then paste a unified diff or use a pull request URL and choose **Analyze change**. Public pull requests are fetched through the GitHub API; private repositories require `GITHUB_TOKEN`.

The first index request creates the pgvector extension and table. The review and test-plan endpoints require an indexed repository so model output is grounded in retrieved code context.

## Playwright regression plans

Choose **Generate Playwright plan** after indexing and providing a pull request URL and diff. The model returns a bounded JSON plan of same-origin navigation, CSS interactions, and assertions; it cannot return executable JavaScript. Download the plan and point the test runner at it:

```powershell
$env:DIFFSENSE_TEST_PLAN = "C:\path\to\diffsense-playwright-plan.json"
$env:PLAYWRIGHT_BASE_URL = "http://localhost:3000"
$env:CI = "1"
npm run test:e2e
```

The containerized workflow executes the checked-in Playwright smoke plan and UI tests:

```powershell
docker compose --profile test up --build --abort-on-container-exit --exit-code-from e2e e2e
docker compose --profile test down
```

## Measure the resume claims

Create a JSON file with human-labeled defects recorded before tool output is inspected. Include every reviewed PR, both manual and assisted findings, paired elapsed minutes, and seeded regression outcomes:

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

Run `npm run evaluate -- path/to/results.json`. Defect matching uses exact file paths and a two-line tolerance. Precision and recall use assisted findings against known defects; review-time savings are the median paired percentage change; manual/assisted defect counts are reported side by side; regression catch rate is detections divided by seeded scenarios. Use the full predeclared cohort (for example, 30 PRs and 40 scenarios) and report its actual results.

## Environment

See `.env.example` for settings. `OPENAI_REVIEW_MODEL` defaults to `gpt-4.1-mini`; `OPENAI_EMBEDDING_MODEL` defaults to `text-embedding-3-small`. `DATABASE_URL` must point to PostgreSQL with permission to install the `vector` extension. `GITHUB_TOKEN` is optional for public repositories.

Repository source chunks are stored in the configured database. Review diffs and retrieved context are sent to the configured OpenAI API. Do not index code unless those data flows are approved for your repository.

## Checks

```powershell
npm run lint
npm run test:unit
npm run build
npm run test:e2e
```

The evaluation harness reports measured values only; this repository does not ship a labeled 30-PR corpus or 40 seeded regression outcomes.
