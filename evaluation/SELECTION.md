# BugsJS Selection Protocol

## Source and provenance

- Dataset: [BugsJS/bug-dataset](https://github.com/BugsJS/bug-dataset), MIT license, dataset version 1.0 (2018-10-15).
- Dataset Git revision used for metadata: `7abbad3e4df12cd5294110bb5db11b7d5bc758a6`.
- The dataset README describes 453 bugs across 10 projects. `Projects.csv` lists their upstream repository URLs and per-project bug counts.
- Each `*_issues.bin` record provides the benchmark bug ID, original report ID, and fixing commit SHA. The `.proto` schema calls these fields `id`, `orig_id`, and `fix.hash`.
- The fixing commit's first parent is the buggy revision. The fixing commit itself is the fixed revision. BugsJS snapshot tags are not substituted for those commit SHAs.
- A report reference is the upstream repository's GitHub issue URL using `orig_id`; no third-party source is copied into this repository.

## Candidate order and stopping rule

Sort project names by lowercase ordinal order, then sort each project's numeric BugsJS bug ID ascending. Inspect candidates in that order and stop immediately after selecting 30 eligible bugs. Select no more than six bugs from a project. The resulting cohort is therefore determined by the first 30 candidates that pass the criteria below, not by model output.

## Eligibility rules

For each candidate, inspect the Git diff from the fixing commit to its first parent (fixed to buggy). Count added plus deleted lines across the complete diff. A candidate is eligible only when all of these conditions hold:

1. The fix changes 1 to 3 non-test JavaScript source files (`.js`, `.jsx`, `.mjs`, or `.cjs`).
2. At least one changed path is a non-test source file. Test files/directories, documentation files/directories, and configuration-only files do not count as source files. A fix that changes only tests, only documentation, or only configuration is excluded.
3. The complete fix diff changes at most 150 lines, counting both additions and deletions across source, tests, documentation, and configuration.
4. The project has fewer than six previously selected bugs.

Test paths include `test/`, `tests/`, `__tests__/`, and filenames ending in `.test.*` or `.spec.*`. Documentation paths include `docs/`, `doc/`, and Markdown, reStructuredText, and plain-text documentation files. Configuration-only paths include JSON, YAML, TOML, INI, lockfiles, dotfiles, and conventional `*config*` files. Source eligibility is restricted to the JavaScript extensions above and excludes generated, vendor, and dependency directories (`dist/`, `build/`, `vendor/`, and `node_modules/`).

Record each inspected rejected candidate and every applicable exclusion reason. Do not inspect later candidates after the 30th eligible case; the predeclared cohort-size stopping rule excludes them without using model output.

## Single fallback if needed

If fewer than 30 candidates pass the initial rules, relax only the complete-diff size cap from 150 to 200 changed lines and re-scan in the same order. Keep the file-count, source classification, project cap, and cohort-size rules unchanged. Record the fallback and all additional candidate decisions in the manifest. If that still yields fewer than 30, stop and report the shortfall rather than relaxing another rule.

## Label construction

Generate each bug-introducing diff as `git diff <fix-sha> <first-parent-sha>`. The known defect locations are the ranges of added lines on the buggy side of that reversed diff, restricted to eligible non-test source files. Merge adjacent added line numbers into inclusive ranges. Store the fixed commit SHA, its first-parent buggy SHA, changed source files, ranges, upstream repo, bug/report IDs, selection decision, and `MAX_INDEX_FILES` cap in `evaluation/manifest.json`.

Selection, diff inspection, and labels are finalized and committed before any DiffSense review or model output is run. Do not alter this protocol or its labels after seeing benchmark results.