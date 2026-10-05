import { getOpenAIClient } from "@/lib/server/ai";

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

export async function reviewDiff(diff: string, addedLines: AddedLine[], context: { path: string; content: string }[]) {
  const openai = getOpenAIClient();
  const contextText = context.map((item) => `FILE: ${item.path}\n${item.content}`).join("\n\n---\n\n");
  const response = await openai.responses.create({
    model: process.env.OPENAI_REVIEW_MODEL ?? "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content: "You are a conservative senior code reviewer. Report only concrete defects introduced by this change. Use the supplied repository context to verify behavior. Do not report style preferences, speculative concerns, or issues already present. Each finding must cite an added line from the diff and propose a concise fix. If no actionable defect is supported, return an empty findings array.",
      },
      {
        role: "user",
        content: `REPOSITORY CONTEXT\n${contextText}\n\nPULL REQUEST DIFF\n${diff}`,
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
  const findings = parsed.findings.filter((finding) => addedLineKeys.has(`${finding.file}:${finding.line}`));
  return { findings, model: process.env.OPENAI_REVIEW_MODEL ?? "gpt-4.1-mini" };
}
