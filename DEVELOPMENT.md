# Development

## Checks

```powershell
npm run lint
npm run test:unit
npm run build
npm run check-results
npm run test:e2e
```

CI (`.github/workflows/ci.yml`) runs lint, unit tests, the build, `npm run check-results`, and the Docker browser suite, which includes one real generated Playwright plan (`tests/fixtures/generated-plan.json`). Evaluation scripts and results are described in [`evaluation/RESULTS.md`](evaluation/RESULTS.md).
