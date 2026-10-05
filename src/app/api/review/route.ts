import { NextResponse } from "next/server";
import { z } from "zod";
import { getOpenAIClient } from "@/lib/server/ai";
import { getIndexedCommit, isTestPath } from "@/lib/server/context";
import { getPullRequestDiff, getPullRequestMergeBase, parseGitHubSource } from "@/lib/server/github";
import { getAddedLines, reviewDiffDetailed } from "@/lib/server/review";
import { appReviewConfig, buildReviewContext } from "@/lib/server/review-pipeline";

export const runtime = "nodejs";
export const maxDuration = 90;

const requestSchema = z.object({
  diff: z.string().max(500_000).optional(),
  pullRequestUrl: z.string().url(),
  skipTestFiles: z.boolean().optional(),
});

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const body = requestSchema.parse(await request.json());
    const source = parseGitHubSource(body.pullRequestUrl);
    if (!body.diff?.trim() && !source.pullNumber) {
      return NextResponse.json({ error: "Paste a diff or provide a GitHub pull request URL." }, { status: 400 });
    }
    const diff = body.diff?.trim() || await getPullRequestDiff(source);
    if (!diff.trim()) return NextResponse.json({ error: "The diff is empty." }, { status: 400 });
    const addedLines = getAddedLines(diff);
    if (addedLines.length === 0) return NextResponse.json({ error: "No added lines were found in the unified diff." }, { status: 400 });

    getOpenAIClient();
    const repositoryKey = `${source.owner}/${source.repository}`.toLowerCase();
    const indexedCommit = await getIndexedCommit(repositoryKey);
    if (!indexedCommit) {
      return NextResponse.json(
        { error: "No repository context is indexed yet. Index this GitHub repository, then run the review again." },
        { status: 409 },
      );
    }
    // Context and full changed files must come from the diff's pre-change side, as in the benchmark.
    if (source.pullNumber) {
      const mergeBase = await getPullRequestMergeBase(source);
      if (mergeBase !== indexedCommit) {
        return NextResponse.json(
          { error: `The index is at ${indexedCommit.slice(0, 7)}, but this pull request's merge-base is ${mergeBase.slice(0, 7)}. Index the pull request again, then review.` },
          { status: 409 },
        );
      }
    }

    const config = appReviewConfig(body.skipTestFiles ?? true);
    const built = await buildReviewContext({ owner: source.owner, repository: source.repository, repositoryKey, baseCommit: indexedCommit, diff, config });
    if (built.chunks.length === 0) {
      return NextResponse.json(
        { error: "No repository context is indexed yet. Index this GitHub repository, then run the review again." },
        { status: 409 },
      );
    }

    const review = await reviewDiffDetailed(diff, addedLines, built.context, undefined, config.promptRevision, config.acceptance);
    // The measured configuration only asks the model to skip tests; the app also enforces the toggle on accepted findings.
    const findings = (body.skipTestFiles ?? true) ? review.findings.filter((finding) => !isTestPath(finding.file)) : review.findings;
    return NextResponse.json({
      findings,
      model: review.model,
      contextUsed: built.chunks.length,
      changedFilesIncluded: built.changedFiles.length,
      changedFilesSkipped: built.changedFilesSkipped,
      contextCommit: indexedCommit,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const message = error instanceof z.ZodError
      ? "Provide a GitHub repository or pull request URL and a unified diff."
      : error instanceof Error
        ? error.message
        : "The review could not be completed.";
    const status = message.includes("not configured") ? 503 : message.includes("URL") || message.includes("diff") ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
