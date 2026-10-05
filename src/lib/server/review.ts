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

type DiffHunk = { added: AddedLine[] };
type DiffLineIndex = {
  added: Set<string>;
  context: Set<string>;
  removed: Map<string, DiffHunk[]>;
};

/** Indexes a unified diff: added and context lines by new-file number, removed lines by old-file number with their hunk. */
export function indexDiffLines(diff: string): DiffLineIndex {
  const index: DiffLineIndex = { added: new Set(), context: new Set(), removed: new Map() };
  let path = "";
  let oldLine = 0;
  let newLine = 0;
  let hunk: DiffHunk | null = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      hunk = null;
    } else if (line.startsWith("+++ ")) {
      path = line.startsWith("+++ b/") ? line.slice(6) : "";
      hunk = null;
    } else if (line.startsWith("--- ") && !hunk) {
      continue;
    } else if (line.startsWith("@@")) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      hunk = match ? { added: [] } : null;
      oldLine = Number(match?.[1] ?? 0);
      newLine = Number(match?.[2] ?? 0);
    } else if (hunk && path) {
      if (line.startsWith("+")) {
        index.added.add(`${path}:${newLine}`);
        hunk.added.push({ path, line: newLine });
        newLine += 1;
      } else if (line.startsWith("-")) {
        const key = `${path}:${oldLine}`;
        index.removed.set(key, [...(index.removed.get(key) ?? []), hunk]);
        oldLine += 1;
      } else if (line.startsWith(" ")) {
        index.context.add(`${path}:${newLine}`);
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return index;
}

export type AcceptancePolicy = "exact" | "remap-removed";

/**
 * Keeps findings on exact added lines. With "remap-removed", a finding citing the old-file number of a removed line
 * (that is not also an unchanged context line) moves to the nearest added line of that removed line's hunk.
 */
export function acceptFindings<T extends { file: string; line: number }>(findings: T[], diff: string, policy: AcceptancePolicy = "exact") {
  const index = indexDiffLines(diff);
  const accepted: (T & { remappedFrom?: number })[] = [];
  for (const finding of findings) {
    const key = `${finding.file}:${finding.line}`;
    if (index.added.has(key)) {
      accepted.push(finding);
      continue;
    }
    if (policy !== "remap-removed" || index.context.has(key)) continue;
    const candidates = (index.removed.get(key) ?? []).flatMap((hunk) => hunk.added);
    if (candidates.length === 0) continue;
    const target = candidates.reduce((best, line) => {
      const distance = Math.abs(line.line - finding.line);
      const bestDistance = Math.abs(best.line - finding.line);
      return distance < bestDistance || (distance === bestDistance && line.line < best.line) ? line : best;
    });
    accepted.push({ ...finding, line: target.line, remappedFrom: finding.line });
  }
  return accepted;
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

export async function reviewDiff(diff: string, addedLines: AddedLine[], context: { path: string; content: string }[]) {
  const result = await reviewDiffDetailed(diff, addedLines, context);
  return { findings: result.findings, model: result.model };
}

const baselineSystemPrompt = "You are a conservative senior code reviewer. Report only concrete defects introduced by this change. Use the supplied repository context to verify behavior. Do not report style preferences, speculative concerns, or issues already present. Each finding must cite an added line from the diff and propose a concise fix. If no actionable defect is supported, return an empty findings array.";

// Every revision keeps the baseline text verbatim; revisions only append. See evaluation/IMPROVEMENTS.md.
export const reviewPromptRevisions = {
  baseline: baselineSystemPrompt,
  "cite-added-line": `${baselineSystemPrompt} Set "line" to the new-file line number of the added ('+') line in the diff where the defect appears; never cite a removed line, an unchanged context line, or a line number from the repository context.`,
  "cite-added-line-source-focus": `${baselineSystemPrompt} Set "line" to the new-file line number of the added ('+') line in the diff where the defect appears; never cite a removed line, an unchanged context line, or a line number from the repository context. Focus on application source code; do not report findings in test files.`,
} as const;
export type ReviewPromptRevision = keyof typeof reviewPromptRevisions;

export function getReviewPromptHash(revision: ReviewPromptRevision = "baseline") {
  return createHash("sha256").update(JSON.stringify({
    system: reviewPromptRevisions[revision],
    schema: reviewSchema,
  })).digest("hex");
}

export const reviewPromptHash = getReviewPromptHash("baseline");

export async function reviewDiffDetailed(
  diff: string,
  addedLines: AddedLine[],
  context: { path: string; content: string }[],
  budget?: OpenAIBudget,
  promptRevision: ReviewPromptRevision = "baseline",
  acceptance: AcceptancePolicy = "exact",
) {
  const reviewSystemPrompt = reviewPromptRevisions[promptRevision];
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
  const addedLineKeys = new Set(addedLines.map(({ path, line }) => `${path}:${line}`));
  const findings = acceptance === "exact"
    ? parsed.findings.filter((finding) => addedLineKeys.has(`${finding.file}:${finding.line}`))
    : acceptFindings(parsed.findings, diff, acceptance);
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
    promptHash: getReviewPromptHash(promptRevision),
    usage,
  };
}
