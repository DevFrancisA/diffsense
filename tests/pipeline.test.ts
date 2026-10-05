import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getPullRequestMergeBase } from "../src/lib/server/github";
import { diffAppliesToFile } from "../src/lib/server/context";
import { acceptFindings, getReviewPromptHash } from "../src/lib/server/review";
import { appReviewConfig, baselineReviewConfig, c4ReviewConfig, finalReviewConfig, uniteSamples } from "../src/lib/server/review-pipeline";

test("resolves a pull request's merge-base through the compare API", async () => {
  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    requested.push(String(url));
    const body = String(url).includes("/compare/")
      ? { merge_base_commit: { sha: "mergebase000" } }
      : { base: { sha: "base111" }, head: { sha: "head222" } };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await getPullRequestMergeBase({ owner: "acme", repository: "store", pullNumber: 7 }), "mergebase000");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(requested, [
    "https://api.github.com/repos/acme/store/pulls/7",
    "https://api.github.com/repos/acme/store/compare/base111...head222",
  ]);
});

test("the app's default review configuration is the measured final configuration", () => {
  assert.deepEqual(appReviewConfig(true), finalReviewConfig);
  assert.equal(appReviewConfig(false).promptRevision, "post-change-with-tests");
  assert.equal(appReviewConfig(false).changedFilesExcludeTests, false);
  assert.equal(appReviewConfig(false).acceptance, "remap-removed");
  const measured = JSON.parse(readFileSync("evaluation/results-dev-c5.json", "utf8")) as { reviewPromptSha256: string; pipelineConfig: { changedFileSide?: string; acceptance?: string } };
  assert.equal(getReviewPromptHash(finalReviewConfig.promptRevision), measured.reviewPromptSha256);
  assert.equal(finalReviewConfig.changedFileSide, measured.pipelineConfig.changedFileSide);
  assert.equal(finalReviewConfig.acceptance, measured.pipelineConfig.acceptance);
  assert.equal(finalReviewConfig.samples, 2);
  const c3 = JSON.parse(readFileSync("evaluation/results-dev-c3.json", "utf8")) as { reviewPromptSha256: string };
  assert.equal(getReviewPromptHash(c4ReviewConfig.promptRevision), c3.reviewPromptSha256);
  const baseline = JSON.parse(readFileSync("evaluation/results.json", "utf8")) as { reviewPromptSha256: string };
  assert.equal(getReviewPromptHash(baselineReviewConfig.promptRevision), baseline.reviewPromptSha256);
});

test("remaps removed-line citations the same way with or without diff context", () => {
  const zeroContext = ["--- a/src/x.js", "+++ b/src/x.js", "@@ -13,3 +13 @@", "-a", "-b", "-c", "+x"].join("\n");
  const withContext = ["--- a/src/x.js", "+++ b/src/x.js", "@@ -10,9 +10,7 @@", " l10", " l11", " l12", "-a", "-b", "-c", "+x", " l16", " l17", " l18"].join("\n");
  const findings = [{ file: "src/x.js", line: 14 }, { file: "src/x.js", line: 15 }];
  const expected = [{ file: "src/x.js", line: 13, remappedFrom: 14 }, { file: "src/x.js", line: 13, remappedFrom: 15 }];
  assert.deepEqual(acceptFindings(findings, zeroContext, "remap-removed"), expected);
  assert.deepEqual(acceptFindings(findings, withContext, "remap-removed"), expected);
});

test("labels a changed file as pre-change only when the diff applies to it", () => {
  const diff = ["diff --git a/src/x.js b/src/x.js", "--- a/src/x.js", "+++ b/src/x.js", "@@ -2,2 +2,2 @@", " keep();", "-old();", "+next();"].join("\n");
  assert.equal(diffAppliesToFile(diff, "src/x.js", ["first();", "keep();", "old();"].join("\n")), true);
  assert.equal(diffAppliesToFile(diff, "src/x.js", ["first();", "keep();", "next();"].join("\n")), false);
  assert.equal(diffAppliesToFile(diff, "src/other.js", "anything"), true);
});

test("unites review samples by file and line", () => {
  const first = [{ file: "a.js", line: 3, title: "x" }, { file: "a.js", line: 9, title: "y" }];
  const second = [{ file: "a.js", line: 3, title: "x again" }, { file: "b.js", line: 1, title: "z" }];
  assert.deepEqual(uniteSamples([first, second]).map((finding) => `${finding.file}:${finding.line}:${finding.title}`), ["a.js:3:x", "a.js:9:y", "b.js:1:z"]);
});
