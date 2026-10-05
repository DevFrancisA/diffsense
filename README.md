# DiffSense

**Context-aware code review for maintainers and engineering teams.**

DiffSense retrieves repository context to help reviewers identify defects in pull request diffs and generate Playwright regression-test plans.

## Features

- **Repository indexing:** Index supported GitHub source files into PostgreSQL with pgvector embeddings.
- **Context-aware reviews:** Analyze diffs using the full post-change text of changed source files and relevant repository code.
- **Structured findings:** View severity, changed-file line, explanation, and suggested fix for each candidate defect.
- **Regression-test planning:** Generate downloadable Playwright plans with browser actions and assertions for behavior affected by a change.
- **Pull request support:** Load changes from a GitHub pull request URL or paste a unified diff.

## Local setup

### Requirements

- Node.js 24 or newer
- Docker Desktop with Compose
- An OpenAI API key
- A GitHub token for private repositories or higher API rate limits (optional for public repositories)

### Install and start

From the project directory, copy the environment template:

```powershell
Copy-Item .env.example .env.local
```

Set `OPENAI_API_KEY` in `.env.local`. For private repositories, also set `GITHUB_TOKEN`. Ensure `DATABASE_URL` points to the PostgreSQL instance started by Compose. See `.env.example` for the available settings.

Start the database and app:

```powershell
docker compose up -d postgres
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The sample diff loads without credentials. Indexing and AI actions require the configured database and API key.

## Review a change

1. Enter a GitHub repository or pull request URL.
2. Select **Index repository context**.
3. Paste a unified diff or use a pull request URL, then select **Analyze change**.
4. Inspect the findings and suggested fixes.

Indexing a pull request uses its merge-base commit; indexing a repository uses its default branch. One commit is indexed per repository at a time, so re-index before reviewing a different pull request. By default, indexing includes up to 40 supported source files and skips files larger than 80 KB.

## Run generated regression tests

Select **Generate Playwright plan** after indexing and providing a change. Optionally describe the app's starting state, such as whether the user is signed out or a feature flag is disabled.

Download the JSON plan and run it against the app's base build first. Discard scenarios that fail on the base build, then run the remaining scenarios against the changed build.

```powershell
$env:DIFFSENSE_TEST_PLAN = "C:\path\to\diffsense-playwright-plan.json"
$env:PLAYWRIGHT_BASE_URL = "http://localhost:3000"
$env:CI = "1"
npm run test:e2e
```

Plans support same-origin navigation, CSS-based interactions, and assertions for visibility, enabled state, text, values, attributes, and URLs. The runner uses a fixed set of actions and does not execute model-generated JavaScript.

To run the browser suite in containers:

```powershell
docker compose --profile test up --build --abort-on-container-exit --exit-code-from e2e e2e
docker compose --profile test down
```

## Usage notes

Review findings and generated plans before relying on them. DiffSense does not post GitHub comments or modify repositories.

Repository chunks are stored in your configured database, and source and diff content is sent to OpenAI. Keep `.env.local` out of version control. Use this version locally or in a trusted single-operator environment; it does not include authentication or multi-user access controls.
