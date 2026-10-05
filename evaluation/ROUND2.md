# Round 2: preregistration

Written and committed before any Round-2 number was computed. Evaluator, labels, cohorts, and the ±2-line one-to-one matching rule are unchanged. OpenAI usage stays inside the session ledger (`ledger/session-2.json`, cap 1,000 calls / 10M tokens). From this round on, the ledger's token projection is API-reported usage so far plus the next batch's estimate. Previously it was the sum of estimates, which ran about 40% above actual usage. The cap itself is unchanged.

No human reviewer is available in this round. Every check described as "judged" is done by Claude agents and is labelled as model-judged, never as human-confirmed.

## R1. Remap removed-line citations (config C4)

- **Rule (`acceptance: "remap-removed"`).** A finding on an exact added line is kept unchanged. Otherwise, if its line number equals the old-file number of a removed (`-`) line in the same file, that line is not also an unchanged-context line in the new file, and the removed line's hunk contains at least one added line, the finding is moved to that hunk's added line nearest the cited number (ties go to the lower line). It keeps `remappedFrom`. Everything else is dropped as before.
- **C4** = C3 plus this rule. It is computed by re-scoring the saved C3 raw findings, with no new API calls. The re-scorer must first reproduce the committed exact-gate metrics for every variant it touches.
- **Adoption rule** (same as Round 1): adopt C4 if its pooled DEV precision is at least 90% and its pooled DEV recall exceeds C3's. If adopted, apply it exactly once to the saved HOLDOUT outputs of both configurations. Report how many matches came from remapped findings.

## R2. False alarms on correct code, and paired analysis

- **Forward-fix arm.** For every HOLDOUT case, review the real fix diff `git diff <buggy> <fix>`, indexed and with changed files read at `<buggy>` (the pre-change side). Configurations: the original baseline and the final configuration (C3, plus C4's acceptance rule if R1 adopts it). One run each, no configuration chosen from these results.
- **False alarm** = any accepted finding on a forward-fix diff. Reported per case (cases with at least one flag) and per finding, with Wilson 95% intervals, split into source and test files. Each flag is then judged by two independent Claude agents ("does the finding describe a real defect in the fixed code?"), and that model-judged rate is reported separately.
- **Source-only precision.** Existing results are re-split into source-file and test-file findings.
- **Paired analysis.** For HOLDOUT baseline vs final, a per-range 2×2 table, an exact McNemar p-value, and a case-clustered bootstrap 95% CI for the recall difference (10,000 resamples, fixed seed).

## R3. Ship the measured configuration

The review context is built by one shared function used by both the benchmark and `/api/review`. Pull requests are indexed at their **merge-base** (the pre-change side), which matches the benchmark. The forward-fix runs in R2 go through the shared function. No separate parity benchmark is run. The claim is "same code path", not a new measurement.

## R4–R6. Plan generation v2 (seeded regressions)

- **R4 normalization.** Before validation, move a same-origin path misplaced in `selector` into `value` for `goto` steps, and move `value` into an empty `expected` for `expectText`/`expectValue`. Then validate each scenario separately: drop invalid scenarios, record why, and fail only when none survive. The error for a misplaced path no longer says "outside the configured application". Replayed with no API calls on the 20 saved rejected outputs.
- **R5/R6 generator v2.** The prompt states that the plan runs on the **pre-change** build and must assert behavior that the patch changes, using exact strings copied from the removed (`-`) lines and the source. New actions: `expectEnabled`, `expectDisabled`, `expectHidden`, `expectAttribute`. `expectValue*` is limited to form fields, and expected strings are literal. An optional environment description is accepted. The harness supplies the credential-free state plus an accessibility snapshot of the baseline page. The app accepts the same environment text from the user (the snapshot is harness-only).
- **Protocol v2** (for v2 runs and the v1 replay). Each scenario of a plan runs twice on the baseline. Scenarios that fail on the baseline are quarantined (dropped). The plan is valid if at least one scenario survives. **Detected** = a surviving scenario fails an assertion step on the patched build. For a **benign control** patch, a **false alarm** = a surviving scenario fails an assertion step on the patched build. Infrastructure rules are unchanged from PROTOCOL.md.
- **v1 replay (post hoc, no API).** The v1 plans' scenarios that already passed both baseline runs are run on their patched builds under protocol v2.
- **DEV v2.** The 40 valid Round-1 scenarios get one v2 plan each.
- **HOLDOUT v2.** 20 new behavior-breaking patches and 10 benign controls (no visible behavior change), committed before any v2 run, generated against a new pushed base commit. One plan each. Report detected/20 and false alarms/10, with Wilson intervals.

## R7. Blind audit of matched findings

For every matched finding in HOLDOUT baseline, HOLDOUT final, and DEV C3, two Claude agents work independently and blind to configuration. They see the case's reversed diff and the stored finding (clipped text). Rubric:

- **(a)** Does the explanation describe the actual defect, i.e. the behavioral consequence of the change? Answer yes/no.
- **(b)** Is the suggestion essentially "restore the removed code"? Answer yes/no.

Report the agreement rate and the counts where both judges say yes. Disagreements are reported, not resolved.
