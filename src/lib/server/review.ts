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
 * moves to the nearest added line of that removed line's hunk. Context lines are deliberately not consulted: the rule was
 * measured on zero-context diffs, and GitHub diffs with context must remap the same way (evaluation/ROUND2.md, R1 amendment).
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
    if (policy !== "remap-removed") continue;
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

// Round 3 (evaluation/ROUND3.md): every finding must name a concrete failure in the post-change code and say whether
// the change itself already fixes the problem it describes.
const postChangeReviewSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...reviewSchema.properties.findings.items.properties,
          failureAfterChange: { type: "string" },
          alreadyFixedByChange: { type: "boolean" },
        },
        required: [...reviewSchema.properties.findings.items.required, "failureAfterChange", "alreadyFixedByChange"],
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
  failureAfterChange?: string;
  alreadyFixedByChange?: boolean;
};

const baselineSystemPrompt = "You are a conservative senior code reviewer. Report only concrete defects introduced by this change. Use the supplied repository context to verify behavior. Do not report style preferences, speculative concerns, or issues already present. Each finding must cite an added line from the diff and propose a concise fix. If no actionable defect is supported, return an empty findings array.";

// Every revision keeps the baseline text verbatim; revisions only append. See evaluation/IMPROVEMENTS.md.
export const reviewPromptRevisions = {
  baseline: baselineSystemPrompt,
  "cite-added-line": `${baselineSystemPrompt} Set "line" to the new-file line number of the added ('+') line in the diff where the defect appears; never cite a removed line, an unchanged context line, or a line number from the repository context.`,
  "cite-added-line-source-focus": `${baselineSystemPrompt} Set "line" to the new-file line number of the added ('+') line in the diff where the defect appears; never cite a removed line, an unchanged context line, or a line number from the repository context. Focus on application source code; do not report findings in test files.`,
  "post-change-with-tests": `${baselineSystemPrompt} Set "line" to the new-file line number of the added ('+') line in the diff where the defect appears; never cite a removed line, an unchanged context line, or a line number from the repository context. Judge the code as it is AFTER this change: the full files supplied for changed paths already include the change. Report a defect only if it exists in the code after the change and the change introduced or exposed it. Never report a problem that this change fixes, never restate or summarize what the change does, and never object to the change's evident intent unless you can name a concrete input that now fails. For each finding, set failureAfterChange to a concrete input or state and the wrong result it produces in the new code, and set alreadyFixedByChange to true if the problem you describe is one the change removes rather than one it leaves or creates.`,
  "post-change": `${baselineSystemPrompt} Set "line" to the new-file line number of the added ('+') line in the diff where the defect appears; never cite a removed line, an unchanged context line, or a line number from the repository context. Focus on application source code; do not report findings in test files. Judge the code as it is AFTER this change: the full files supplied for changed paths already include the change. Report a defect only if it exists in the code after the change and the change introduced or exposed it. Never report a problem that this change fixes, never restate or summarize what the change does, and never object to the change's evident intent unless you can name a concrete input that now fails. For each finding, set failureAfterChange to a concrete input or state and the wrong result it produces in the new code, and set alreadyFixedByChange to true if the problem you describe is one the change removes rather than one it leaves or creates.`,
} as const;
export type ReviewPromptRevision = keyof typeof reviewPromptRevisions;

const postChangeRevisions = new Set<ReviewPromptRevision>(["post-change", "post-change-with-tests"]);

function schemaFor(revision: ReviewPromptRevision) {
  return postChangeRevisions.has(revision) ? postChangeReviewSchema : reviewSchema;
}

export function getReviewPromptHash(revision: ReviewPromptRevision = "baseline") {
  return createHash("sha256").update(JSON.stringify({
    system: reviewPromptRevisions[revision],
    schema: schemaFor(revision),
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
        schema: schemaFor(promptRevision),
      },
    },
  });

  if (!response.output_text) throw new Error("The review model returned no structured findings.");
  const parsed = JSON.parse(response.output_text) as { findings: ReviewFinding[] };
  const addedLineKeys = new Set(addedLines.map(({ path, line }) => `${path}:${line}`));
  // post-change: drop findings the model itself marks as fixed by the change or cannot tie to a concrete failure.
  const candidates = postChangeRevisions.has(promptRevision)
    ? parsed.findings.filter((finding) => finding.alreadyFixedByChange === false && Boolean(finding.failureAfterChange?.trim()))
    : parsed.findings;
  const findings = acceptance === "exact"
    ? candidates.filter((finding) => addedLineKeys.has(`${finding.file}:${finding.line}`))
    : acceptFindings(candidates, diff, acceptance);
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
