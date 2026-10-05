import { createHash } from "node:crypto";
import { type ApiTokenUsage, estimateTokens, getOpenAIClient, type OpenAIBudget } from "@/lib/server/ai";

// Round 3, C6 (evaluation/ROUND3.md): a second model pass that keeps a finding only if it describes a defect present in
// the code after the change. One call per diff that has accepted findings.
const verifierPrompt = "You verify code-review findings. You get a unified diff, the full text of the changed files AFTER the change, and numbered findings that a reviewer attached to added lines. For each finding decide keep=true only if it describes a concrete defect that exists in the code after this change and that the change introduced or exposed. Set keep=false if the finding describes a problem that this change fixes or removes, restates or summarizes what the change does, recommends something the change already does, objects to the change's evident intent without a concrete input that now fails, is a style or naming preference, or is speculation the supplied code does not support. Judge each finding independently and only from the supplied code.";

const verifierSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          index: { type: "integer" },
          keep: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["index", "keep", "reason"],
      },
    },
  },
  required: ["verdicts"],
} as const;

export const verifierPromptHash = createHash("sha256").update(JSON.stringify({ verifierPrompt, verifierSchema })).digest("hex");

type VerifiableFinding = { title: string; file: string; line: number; explanation: string; suggestion: string; failureAfterChange?: string };

export async function verifyFindings<T extends VerifiableFinding>(
  diff: string,
  postChangeFiles: { path: string; content: string }[],
  findings: T[],
  budget?: OpenAIBudget,
) {
  if (findings.length === 0) return { kept: [] as T[], verdicts: [] as { index: number; keep: boolean; reason: string }[], usage: null as ApiTokenUsage | null };
  const numbered = findings.map((finding, index) => `#${index} ${finding.file}:${finding.line} ${finding.title}\nExplanation: ${finding.explanation}\nFailure after change: ${finding.failureAfterChange ?? "(not given)"}\nSuggestion: ${finding.suggestion}`).join("\n\n");
  const files = postChangeFiles.map((file) => `FILE: ${file.path}\n${file.content}`).join("\n\n---\n\n");
  const userContent = `CHANGED FILES AFTER THE CHANGE\n${files || "(not available)"}\n\nDIFF\n${diff}\n\nFINDINGS\n${numbered}`;
  await budget?.beforeBatch("verify_findings", 1, estimateTokens(verifierPrompt + userContent) + 500);
  const response = await getOpenAIClient({ maxRetries: budget ? 0 : undefined }).responses.create({
    model: process.env.OPENAI_REVIEW_MODEL ?? "gpt-4.1-mini",
    input: [
      { role: "system", content: verifierPrompt },
      { role: "user", content: userContent },
    ],
    text: { format: { type: "json_schema", name: "diffsense_verification", strict: true, schema: verifierSchema } },
  });
  const usage: ApiTokenUsage = {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    totalTokens: response.usage?.total_tokens ?? 0,
  };
  await budget?.recordUsage("verify_findings", usage);
  if (!response.output_text) throw new Error("The verifier returned no verdicts.");
  const { verdicts } = JSON.parse(response.output_text) as { verdicts: { index: number; keep: boolean; reason: string }[] };
  // A finding without an explicit keep=true verdict is dropped.
  const kept = findings.filter((_, index) => verdicts.some((verdict) => verdict.index === index && verdict.keep));
  return { kept, verdicts, usage };
}
