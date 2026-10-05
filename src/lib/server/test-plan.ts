import { createHash } from "node:crypto";
import { z } from "zod";
import { type ApiTokenUsage, estimateTokens, getOpenAIClient, type OpenAIBudget } from "@/lib/server/ai";

const v1Actions = ["goto", "click", "fill", "expectVisible", "expectText", "expectValue", "expectValueContains", "expectUrl"] as const;
// v2 (evaluation/ROUND2.md, R5/R6) adds state and attribute assertions.
const v2Actions = [...v1Actions, "expectHidden", "expectEnabled", "expectDisabled", "expectAttribute"] as const;
export type PlanAction = (typeof v2Actions)[number];

const stepSchema = z.object({
  action: z.enum(v2Actions),
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
type PlanStep = RegressionPlan["scenarios"][number]["steps"][number];

function outputSchemaFor(actions: readonly string[]) {
  return {
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
                  action: { type: "string", enum: [...actions] },
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
}

const prompts = {
  v1: "Generate up to five focused browser regression scenarios for behavior changed by this patch. Return only structured test-plan data. Use only the allowed actions: goto, click, fill, expectVisible, expectText, expectValue, expectValueContains, expectUrl. Selectors must be CSS selectors grounded in the supplied source. goto values must be same-origin paths beginning with one slash. Never use external URLs, scripts, shell commands, or arbitrary code. Every step must include all four string fields; use empty strings for fields that do not apply.",
  v2: "Generate up to five focused browser regression scenarios for this patch. The plan is run against the application BEFORE the patch is applied and must pass there; it should fail if the patch's behavior change ships. Therefore assert the pre-change behavior that the patch alters: copy exact strings, labels, attribute values, and enabled/disabled/visible states from the removed ('-') lines and the supplied source, never the new ('+') values. Only assert what is observable in the described application environment. Return only structured test-plan data. Use only the allowed actions: goto, click, fill, expectVisible, expectHidden, expectEnabled, expectDisabled, expectText, expectValue, expectValueContains, expectAttribute, expectUrl. Start every scenario with a goto step. goto steps put a same-origin path beginning with one slash in value and leave selector empty. expectText passes when the element's text contains the literal expected string (no regular expressions). expectValue and expectValueContains apply only to input, textarea, and select elements. expectAttribute puts the attribute name in value and the expected attribute value in expected. Selectors must be CSS selectors grounded in the supplied source. Never use external URLs, scripts, shell commands, or arbitrary code. Every step must include all four string fields; use empty strings for fields that do not apply.",
} as const;
export type TestPlanRevision = keyof typeof prompts;
const schemas = { v1: outputSchemaFor(v1Actions), v2: outputSchemaFor(v2Actions) };

export function getTestPlanPromptHash(revision: TestPlanRevision) {
  // v1 keeps its original fingerprint inputs so Round-1 runs stay comparable.
  return createHash("sha256").update(JSON.stringify({ testPlanSystemPrompt: prompts[revision], outputSchema: schemas[revision] })).digest("hex");
}
export const testPlanPromptHash = getTestPlanPromptHash("v1");

const selectorActions = new Set<string>(["click", "fill", "expectVisible", "expectHidden", "expectEnabled", "expectDisabled", "expectText", "expectValue", "expectValueContains", "expectAttribute"]);

function stepError(step: PlanStep, revision: TestPlanRevision): string | null {
  if (revision === "v1" && !(v1Actions as readonly string[]).includes(step.action)) return `Unsupported action ${step.action}.`;
  if (step.action === "goto" && (!step.value.startsWith("/") || step.value.startsWith("//"))) {
    return revision === "v1" || /^[a-z]+:|^\/\//i.test(step.value)
      ? "Generated test plan contains a navigation target outside the configured application."
      : "Generated test plan has a goto step without a same-origin path.";
  }
  if (selectorActions.has(step.action) && !step.selector.trim() && (revision === "v2" || ["click", "fill", "expectVisible", "expectText", "expectValue"].includes(step.action))) {
    return "Generated test plan is missing a CSS selector.";
  }
  const needsExpected = ["expectText", "expectUrl", "expectAttribute"].includes(step.action)
    // An empty expectValue asserts an empty form field, allowed in v2 only for selectors naming a form field.
    || (step.action === "expectValue" && (revision === "v1" || !/input|textarea|select/i.test(step.selector)));
  if (needsExpected && !step.expected.trim()) return "Generated test plan is missing an expected value.";
  if (step.action === "expectAttribute" && !step.value.trim()) return "Generated test plan is missing an attribute name.";
  return null;
}

/** v2 only: repair two systematic slips seen in Round 1 (evaluation/ROUND2.md, R4) before validation. */
export function normalizePlanStep(step: PlanStep): PlanStep {
  if (step.action === "goto" && !step.value.trim() && step.selector.startsWith("/") && !step.selector.startsWith("//")) {
    return { ...step, value: step.selector, selector: "" };
  }
  if ((step.action === "expectText" || step.action === "expectValue") && !step.expected.trim() && step.value.trim()) {
    return { ...step, expected: step.value, value: "" };
  }
  return step;
}

const looseStepSchema = z.object({ action: z.string(), selector: z.string(), value: z.string(), expected: z.string() });
const loosePlanSchema = z.object({ scenarios: z.array(z.object({ title: z.string(), purpose: z.string(), steps: z.array(looseStepSchema) })) });

/**
 * v1: the whole plan is rejected on the first invalid step (Round-1 behavior).
 * v2: steps are normalized, each scenario is validated on its own, and invalid scenarios are dropped with a reason.
 */
export function validateGeneratedPlan(raw: unknown, revision: TestPlanRevision) {
  if (revision === "v1") {
    const plan = planSchema.parse(raw);
    for (const scenario of plan.scenarios) {
      for (const step of scenario.steps) {
        const error = stepError(step, "v1");
        if (error) throw new Error(error);
      }
    }
    return { plan, dropped: [] as { title: string; reason: string }[] };
  }
  const loose = loosePlanSchema.parse(raw);
  const kept: RegressionPlan["scenarios"] = [];
  const dropped: { title: string; reason: string }[] = [];
  for (const scenario of loose.scenarios.slice(0, 5)) {
    const parsed = planSchema.shape.scenarios.element.safeParse({ ...scenario, steps: scenario.steps.map((step) => (stepSchema.safeParse(step).success ? normalizePlanStep(step as PlanStep) : step)) });
    if (!parsed.success) {
      dropped.push({ title: scenario.title, reason: parsed.error.issues[0]?.message ?? "Invalid scenario." });
      continue;
    }
    const error = parsed.data.steps.map((step) => stepError(step, "v2")).find(Boolean);
    if (error) dropped.push({ title: scenario.title, reason: error });
    else kept.push(parsed.data);
  }
  if (kept.length === 0) throw new Error(`No generated scenario passed validation (${dropped.map((item) => item.reason).join("; ")}).`);
  return { plan: { scenarios: kept }, dropped };
}

export async function generateRegressionPlan(
  diff: string,
  context: { path: string; content: string }[],
  budget?: OpenAIBudget,
  options: { revision?: TestPlanRevision; environment?: string } = {},
) {
  const revision = options.revision ?? "v1";
  const environment = revision === "v2" && options.environment?.trim() ? `APPLICATION ENVIRONMENT\n${options.environment.trim()}\n\n` : "";
  const userContent = `${environment}REPOSITORY CONTEXT\n${context.map((item) => `FILE: ${item.path}\n${item.content}`).join("\n\n---\n\n")}\n\nPULL REQUEST DIFF\n${diff}`;
  await budget?.beforeBatch("test_plan", 1, estimateTokens(prompts[revision] + userContent));
  const response = await getOpenAIClient({ maxRetries: budget ? 0 : undefined }).responses.create({
    model: process.env.OPENAI_REVIEW_MODEL ?? "gpt-4.1-mini",
    input: [
      { role: "system", content: prompts[revision] },
      { role: "user", content: userContent },
    ],
    text: { format: { type: "json_schema", name: "playwright_regression_plan", strict: true, schema: schemas[revision] } },
  });
  const usage: ApiTokenUsage = {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    totalTokens: response.usage?.total_tokens ?? 0,
  };
  await budget?.recordUsage("test_plan", usage);
  if (!response.output_text) throw new Error("The model returned no regression test plan.");
  try {
    const { plan, dropped } = validateGeneratedPlan(JSON.parse(response.output_text), revision);
    return { plan, dropped, usage, model: process.env.OPENAI_REVIEW_MODEL ?? "gpt-4.1-mini", promptHash: getTestPlanPromptHash(revision), rawOutput: response.output_text };
  } catch (error) {
    // Keep the rejected model output so callers that audit generation (the regression harness) can store it.
    if (error && typeof error === "object") Object.assign(error, { rejectedOutput: response.output_text });
    throw error;
  }
}
