import { createHash } from "node:crypto";
import { z } from "zod";
import { type ApiTokenUsage, estimateTokens, getOpenAIClient, type OpenAIBudget } from "@/lib/server/ai";

const stepSchema = z.object({
  action: z.enum(["goto", "click", "fill", "expectVisible", "expectText", "expectValue", "expectValueContains", "expectUrl"]),
  selector: z.string().max(240),
  value: z.string().max(500),
  expected: z.string().max(500),
});

export const planSchema = z.object({
  scenarios: z.array(z.object({
    title: z.string().min(1).max(120),
    purpose: z.string().min(1).max(300),
    steps: z.array(stepSchema).min(1).max(12),
  })).min(1).max(5),
});

export type RegressionPlan = z.infer<typeof planSchema>;

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    scenarios: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          purpose: { type: "string" },
          steps: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                action: { type: "string", enum: ["goto", "click", "fill", "expectVisible", "expectText", "expectValue", "expectValueContains", "expectUrl"] },
                selector: { type: "string" },
                value: { type: "string" },
                expected: { type: "string" },
              },
              required: ["action", "selector", "value", "expected"],
            },
          },
        },
        required: ["title", "purpose", "steps"],
      },
    },
  },
  required: ["scenarios"],
} as const;

const testPlanSystemPrompt = "Generate up to five focused browser regression scenarios for behavior changed by this patch. Return only structured test-plan data. Use only the allowed actions: goto, click, fill, expectVisible, expectText, expectValue, expectValueContains, expectUrl. Selectors must be CSS selectors grounded in the supplied source. goto values must be same-origin paths beginning with one slash. Never use external URLs, scripts, shell commands, or arbitrary code. Every step must include all four string fields; use empty strings for fields that do not apply.";

export const testPlanPromptHash = createHash("sha256").update(JSON.stringify({ testPlanSystemPrompt, outputSchema })).digest("hex");

function validatePlanTargets(scenarios: RegressionPlan["scenarios"]) {
  for (const scenario of scenarios) {
    for (const step of scenario.steps) {
      if (step.action === "goto" && (!step.value.startsWith("/") || step.value.startsWith("//"))) {
        throw new Error("Generated test plan contains a navigation target outside the configured application.");
      }
      if (["click", "fill", "expectVisible", "expectText", "expectValue"].includes(step.action) && !step.selector.trim()) {
        throw new Error("Generated test plan is missing a CSS selector.");
      }
      if (["expectText", "expectValue", "expectUrl"].includes(step.action) && !step.expected.trim()) {
        throw new Error("Generated test plan is missing an expected value.");
      }
    }
  }
}

export async function generateRegressionPlan(diff: string, context: { path: string; content: string }[], budget?: OpenAIBudget) {
  const userContent = `REPOSITORY CONTEXT\n${context.map((item) => `FILE: ${item.path}\n${item.content}`).join("\n\n---\n\n")}\n\nPULL REQUEST DIFF\n${diff}`;
  await budget?.beforeBatch("test_plan", 1, estimateTokens(testPlanSystemPrompt + userContent));
  const response = await getOpenAIClient({ maxRetries: budget ? 0 : undefined }).responses.create({
    model: process.env.OPENAI_REVIEW_MODEL ?? "gpt-4.1-mini",
    input: [
      { role: "system", content: testPlanSystemPrompt },
      { role: "user", content: userContent },
    ],
    text: { format: { type: "json_schema", name: "playwright_regression_plan", strict: true, schema: outputSchema } },
  });
  const usage: ApiTokenUsage = {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    totalTokens: response.usage?.total_tokens ?? 0,
  };
  await budget?.recordUsage("test_plan", usage);
  if (!response.output_text) throw new Error("The model returned no regression test plan.");
  let plan: RegressionPlan;
  try {
    plan = planSchema.parse(JSON.parse(response.output_text));
    validatePlanTargets(plan.scenarios);
  } catch (error) {
    // Keep the rejected model output so callers that audit generation (the regression harness) can store it.
    if (error && typeof error === "object") Object.assign(error, { rejectedOutput: response.output_text });
    throw error;
  }
  return { plan, usage, model: process.env.OPENAI_REVIEW_MODEL ?? "gpt-4.1-mini", promptHash: testPlanPromptHash };
}
