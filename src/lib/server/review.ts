import { createHash } from "node:crypto";
import { type ApiTokenUsage, estimateTokens, getOpenAIClient, type OpenAIBudget } from "@/lib/server/ai";

export type AddedLine = { path: string; line: number };

export function getAddedLines(diff: string): AddedLine[] {
  const addedLines: AddedLine[] = [];
  let currentPath = "";
  let currentLine = 0;
  let inHunk = false;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      currentPath = line.slice(6);
      inHunk = false;
    } else if (line.startsWith("@@")) {
      const match = line.match(/\+(\d+)(?:,(\d+))?/);
      currentLine = Number(match?.[1] ?? 0);
      inHunk = Boolean(match);
    } else if (inHunk && line.startsWith("+") && !line.startsWith("+++")) {
      addedLines.push({ path: currentPath, line: currentLine });
      currentLine += 1;
    } else if (inHunk && line.startsWith(" ")) {
      currentLine += 1;
    }
  }
  return addedLines;
}

const reviewSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          file: { type: "string" },
          line: { type: "integer" },
          explanation: { type: "string" },
          suggestion: { type: "string" },
        },
        required: ["title", "severity", "file", "line", "explanation", "suggestion"],
      },
    },
  },
  required: ["findings"],
} as const;

type ReviewFinding = {
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number;
  explanation: string;
  suggestion: string;
};

export const reviewPromptRevision = "recall-v2";

const reviewSystemPrompt = "You are a systematic senior code reviewer. Inspect every changed hunk and trace changed behavior through the supplied repository context. Actively check boundary inputs, missing validation, authorization, error paths, state transitions, compatibility, and interactions with callers. Report each defect or evidence-backed conditional risk that could cause incorrect behavior; do not suppress a concrete risk merely because it requires a particular input or execution path. Avoid style preferences and unsupported speculation. For every finding, cite the most relevant changed line and explain the triggering condition, impact, and a concise fix. If you find no issue, return an empty findings array only after checking all changed hunks against the context.";
const findingAnchorPolicy = "accept-only-same-file-findings-within-two-lines-of-an-added-line; snap-to-nearest-added-line; ties-to-lower-line";

export function anchorFindingToAddedLine<T extends { file: string; line: number }>(finding: T, addedLines: AddedLine[], tolerance = 2): T | null {
  let closestLine: AddedLine | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const addedLine of addedLines) {
    const distance = Math.abs(addedLine.line - finding.line);
    if (addedLine.path === finding.file && distance <= tolerance
      && (distance < closestDistance || (distance === closestDistance && closestLine && addedLine.line < closestLine.line))) {
      closestLine = addedLine;
      closestDistance = distance;
    }
  }
  return closestLine ? { ...finding, line: closestLine.line } : null;
}

export async function reviewDiff(diff: string, addedLines: AddedLine[], context: { path: string; content: string }[]) {
  const result = await reviewDiffDetailed(diff, addedLines, context);
  return { findings: result.findings, model: result.model };
}

export const reviewPromptHash = createHash("sha256").update(JSON.stringify({
  revision: reviewPromptRevision,
  system: reviewSystemPrompt,
  schema: reviewSchema,
  findingAnchorPolicy,
})).digest("hex");

export async function reviewDiffDetailed(
  diff: string,
  addedLines: AddedLine[],
  context: { path: string; content: string }[],
  budget?: OpenAIBudget,
) {
  const openai = getOpenAIClient({ maxRetries: budget ? 0 : undefined });
  const contextText = context.map((item) => `FILE: ${item.path}\n${item.content}`).join("\n\n---\n\n");
  const userContent = `REPOSITORY CONTEXT\n${contextText}\n\nPULL REQUEST DIFF\n${diff}`;
  await budget?.beforeBatch("review_response", 1, estimateTokens(reviewSystemPrompt + userContent) + 1000);
  const response = await openai.responses.create({
    model: process.env.OPENAI_REVIEW_MODEL ?? "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content: reviewSystemPrompt,
      },
      {
        role: "user",
        content: userContent,
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "diffsense_review",
        strict: true,
        schema: reviewSchema,
      },
    },
  });

  if (!response.output_text) throw new Error("The review model returned no structured findings.");
  const parsed = JSON.parse(response.output_text) as { findings: ReviewFinding[] };
  const findings = parsed.findings.flatMap((finding) => {
    const anchored = anchorFindingToAddedLine(finding, addedLines);
    return anchored ? [anchored] : [];
  });
  const usage: ApiTokenUsage = {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    totalTokens: response.usage?.total_tokens ?? 0,
  };
  await budget?.recordUsage("review_response", usage);
  return {
    findings,
    rawFindings: parsed.findings,
    model: process.env.OPENAI_REVIEW_MODEL ?? "gpt-4.1-mini",
    promptRevision: reviewPromptRevision,
    promptHash: reviewPromptHash,
    usage,
  };
}
