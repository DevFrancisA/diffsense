import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getPullRequestMergeBase } from "../src/lib/server/github";
import { getReviewPromptHash } from "../src/lib/server/review";
import { appReviewConfig, baselineReviewConfig, finalReviewConfig } from "../src/lib/server/review-pipeline";

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
  assert.equal(appReviewConfig(false).promptRevision, "cite-added-line");
  assert.equal(appReviewConfig(false).changedFilesExcludeTests, false);
  assert.equal(appReviewConfig(false).acceptance, "remap-removed");
  const measured = JSON.parse(readFileSync("evaluation/results-dev-c3.json", "utf8")) as { reviewPromptSha256: string };
  assert.equal(getReviewPromptHash(finalReviewConfig.promptRevision), measured.reviewPromptSha256);
  const baseline = JSON.parse(readFileSync("evaluation/results.json", "utf8")) as { reviewPromptSha256: string };
  assert.equal(getReviewPromptHash(baselineReviewConfig.promptRevision), baseline.reviewPromptSha256);
});
