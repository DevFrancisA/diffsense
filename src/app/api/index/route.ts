import { NextResponse } from "next/server";
import { z } from "zod";
import { getOpenAIClient } from "@/lib/server/ai";
import { indexRepository } from "@/lib/server/context";
import { getPullRequestMergeBase, parseGitHubSource } from "@/lib/server/github";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({ sourceUrl: z.string().url(), ref: z.string().max(200).optional() });

export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await request.json());
    const source = parseGitHubSource(body.sourceUrl);
    getOpenAIClient();
    // A pull request is indexed at its merge-base (pre-change side), the commit its review context must come from.
    const ref = body.ref ?? (source.pullNumber ? await getPullRequestMergeBase(source) : undefined);
    const result = await indexRepository(source.owner, source.repository, ref);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof z.ZodError
      ? "Provide a valid GitHub repository URL."
      : error instanceof Error
        ? error.message
        : "Repository indexing failed.";
    const status = message.includes("not configured") ? 503 : message.includes("URL") ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
