import { NextResponse } from "next/server";
import { z } from "zod";
import { getOpenAIClient } from "@/lib/server/ai";
import { retrieveRepositoryContext } from "@/lib/server/context";
import { getPullRequestDiff, parseGitHubSource } from "@/lib/server/github";
import { getAddedLines, reviewDiff } from "@/lib/server/review";

export const runtime = "nodejs";
export const maxDuration = 90;

const requestSchema = z.object({
  diff: z.string().max(500_000).optional(),
  pullRequestUrl: z.string().url(),
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
    const repository = `${source.owner}/${source.repository}`.toLowerCase();
    const context = await retrieveRepositoryContext(repository, diff);
    if (context.length === 0) {
      return NextResponse.json(
        { error: "No repository context is indexed yet. Index this GitHub repository, then run the review again." },
        { status: 409 },
      );
    }

    const review = await reviewDiff(diff, addedLines, context);
    return NextResponse.json({
      ...review,
      contextUsed: context.length,
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
