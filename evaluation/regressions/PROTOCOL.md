# Regression-detection protocol

Registered before any scenario was run. Definitions below must not change after results are seen.

## Scenarios

- `scenarios.json` lists 50 small, behavior-breaking patches to DiffSense's own credential-free UI (no `OPENAI_API_KEY`, no `DATABASE_URL`). `make-regression-patches.ts` turns each into `<id>.patch` against one base commit.
- Scenarios 1–40 are **primary**. Scenarios 41–50 are **reserves**, used strictly in listed order and only to replace scenarios that are invalid because of infrastructure failures. The order was fixed before any run.
- The patches were authored with Claude Code assistance. Before registration they were checked only for applying cleanly and typechecking; no plan was generated or run against them before this protocol was committed.

## Procedure (`scripts/regressions.ts`)

1. The base commit must be on `origin/main`. It is indexed once from GitHub at that SHA, so only files tracked at that pushed commit are sent for embedding. `.env*` files (other than `.env.example`) abort the run.
2. Per scenario, in a dedicated patched git worktree reset to the base commit: apply the patch, then `next build`. Both happen before any API call.
3. Generate a plan from the patch diff with `generateRegressionPlan`, the same prompt, schema, and validation that `/api/tests/generate` uses, plus the same retrieval call (top 8 chunks for the first 12,000 diff characters). One generation per scenario; there are no regenerations.
4. Run the plan with `tests/generated-plan.spec.ts` (`--retries=0`, one worker) against the credential-free baseline build twice. If both pass, run it once against the credential-free patched build.

## Outcome definitions

Each failed plan test is classified by the plan step that failed:

- `assertion`: an `expect*` step failed.
- `action`: a `click` or `fill` step failed.
- `infra`: a `goto` step failed, a network/browser-closed error occurred, no plan step carries the error, or the runner produced no parseable report.

A run's outcome is `infra` if any test is infra. Otherwise it is `assertion` if any test is assertion, then `action`, then `pass`.

Scenario status:

- **detected**: the plan passes on baseline both times and the patched run's outcome is `assertion` (an assertion failure on one of the plan's own steps).
- **not detected**: the plan passes on baseline both times and the patched run passes. Conservatively, a patched run whose only failures are `action` steps is also counted as not detected and reported separately in `reason`.
- **invalid plan**: a baseline run fails for a non-infrastructure reason, or plan generation is rejected by the schema or target validation. These count as valid scenarios and are reported.
- **infra-invalid**: the patch does not apply, the build fails, a server does not start, an OpenAI API/network error occurs during generation, or any run's outcome is `infra`. These are replaced by the next reserve until 40 scenarios are valid. The number replaced is reported.

## Reported metrics

`detected / 40` (valid scenarios) and `detected / valid plans`, where valid plans = valid scenarios − invalid plans.

## Budget

OpenAI usage is recorded in `evaluation/ledger/session-2.json`. The session cap is 1,000 calls and 10M tokens, and the ledger refuses any batch that would exceed it. Estimate: 1–2 index embedding calls, then 2 calls per scenario (one retrieval embedding, one plan generation), so at most 102 calls.
