import { NextResponse } from "next/server";
import { z } from "zod";
import { retrieveRepositoryContext } from "@/lib/server/context";
import { getPullRequestDiff, parseGitHubSource } from "@/lib/server/github";
import { generateRegressionPlan } from "@/lib/server/test-plan";

export const runtime = "nodejs";
export const maxDuration = 90;

const requestSchema = z.object({
  diff: z.string().max(500_000).optional(),
  pullRequestUrl: z.string().url(),
  environment: z.string().max(4_000).optional(),
});

export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await request.json());
    const source = parseGitHubSource(body.pullRequestUrl);
    if (!body.diff?.trim() && !source.pullNumber) {
      return NextResponse.json({ error: "Paste a diff or provide a GitHub pull request URL." }, { status: 400 });
    }
    const diff = body.diff?.trim() || await getPullRequestDiff(source);
    const repository = `${source.owner}/${source.repository}`.toLowerCase();
    const context = await retrieveRepositoryContext(repository, diff);
    if (context.length === 0) {
      return NextResponse.json({ error: "Index this repository before generating regression tests." }, { status: 409 });
    }

    const { plan, dropped } = await generateRegressionPlan(diff, context, undefined, { revision: "v2", environment: body.environment });
    return NextResponse.json({ ...plan, dropped });
  } catch (error) {
    const message = error instanceof z.ZodError
      ? "Provide a valid GitHub URL and a unified diff or pull request."
      : error instanceof Error
        ? error.message
        : "Regression test generation failed.";
    const status = message.includes("not configured") ? 503 : message.includes("URL") || message.includes("diff") ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
