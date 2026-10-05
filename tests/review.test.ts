import assert from "node:assert/strict";
import test from "node:test";
import { evaluate } from "../src/lib/evaluation";
import { parseGitHubSource } from "../src/lib/server/github";
import { getAddedLines } from "../src/lib/server/review";

test("parses repository and pull request sources", () => {
  assert.deepEqual(parseGitHubSource("https://github.com/acme/store"), {
    owner: "acme",
    repository: "store",
  });
  assert.deepEqual(parseGitHubSource("https://github.com/acme/store/pull/27/files"), {
    owner: "acme",
    repository: "store",
    pullNumber: 27,
  });
});

test("rejects non-GitHub sources", () => {
  assert.throws(() => parseGitHubSource("https://example.com/acme/store"), /github.com/);
  assert.throws(() => parseGitHubSource("https://github.com/acme/store/issues/2"), /pull request/);
});

test("maps only added patch lines to their new-file line numbers", () => {
  const diff = [
    "diff --git a/src/auth.ts b/src/auth.ts",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -7,3 +7,4 @@",
    " unchanged();",
    "+ authorize(user);",
    "- oldCheck();",
    " return result;",
  ].join("\n");

  assert.deepEqual(getAddedLines(diff), [{ path: "src/auth.ts", line: 8 }]);
});

test("tracks added lines across multiple files and hunks", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,0 +1,2 @@",
    "+first();",
    "+second();",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -10,1 +10,2 @@",
    " context();",
    "+added();",
  ].join("\n");

  assert.deepEqual(getAddedLines(diff), [
    { path: "a.ts", line: 1 },
    { path: "a.ts", line: 2 },
    { path: "b.ts", line: 11 },
  ]);
});

test("computes defect precision, recall, paired median savings, and regression catch rate", () => {
  const metrics = evaluate({
    pullRequests: [
      {
        id: "pr-1",
        knownDefects: [{ file: "a.ts", startLine: 10, endLine: 12 }, { file: "b.ts", line: 20 }],
        manualFindings: [{ file: "a.ts", line: 10 }],
        assistedFindings: [{ file: "a.ts", line: 11 }, { file: "c.ts", line: 5 }],
        manualMinutes: 20,
        assistedMinutes: 12,
      },
      {
        id: "pr-2",
        knownDefects: [{ file: "d.ts", line: 30 }],
        manualFindings: [],
        assistedFindings: [{ file: "d.ts", line: 30 }],
        manualMinutes: 10,
        assistedMinutes: 5,
      },
    ],
    regressionScenarios: [{ id: "seed-1", detected: true }, { id: "seed-2", detected: false }],
  });

  assert.equal(metrics.precision, 2 / 3);
  assert.equal(metrics.recall, 2 / 3);
  assert.equal(metrics.reviewTimeSavingsMedianPercent, 45);
  assert.equal(metrics.manualDefectsFound, 1);
  assert.equal(metrics.assistedDefectsFound, 2);
  assert.equal(metrics.falsePositives, 1);
  assert.equal(metrics.regressionCatchRate, 0.5);
  assert.equal(metrics.perPullRequest[0].falsePositives, 1);
});

test("matches inclusive range boundaries with two-line tolerance and counts unmatched findings once", () => {
  const metrics = evaluate({
    pullRequests: [{
      id: "range-boundaries",
      knownDefects: [{ file: "src/a.js", startLine: 10, endLine: 12 }],
      manualFindings: [],
      assistedFindings: [
        { file: "src/a.js", line: 8 },
        { file: "src/a.js", line: 14 },
        { file: "src/a.js", line: 15 },
      ],
    }],
  });

  assert.equal(metrics.precision, 1 / 3);
  assert.equal(metrics.recall, 1);
  assert.equal(metrics.falsePositives, 2);
  assert.equal(metrics.reviewTimeSavingsMedianPercent, null);
  assert.equal(metrics.regressionCatchRate, null);
  assert.deepEqual(metrics.perPullRequest.map((row) => row.reviewTimeSavingsPercent), [null]);
});

test("returns null quality rates for an empty evaluation dataset", () => {
  const metrics = evaluate({ pullRequests: [], regressionScenarios: [] });

  assert.equal(metrics.precision, null);
  assert.equal(metrics.recall, null);
  assert.equal(metrics.reviewTimeSavingsMedianPercent, null);
  assert.equal(metrics.regressionCatchRate, null);
  assert.equal(metrics.falsePositives, 0);
  assert.deepEqual(metrics.perPullRequest, []);
});
