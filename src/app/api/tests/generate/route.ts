import { NextResponse } from "next/server";
import { z } from "zod";
import { getOpenAIClient } from "@/lib/server/ai";
import { retrieveRepositoryContext } from "@/lib/server/context";
import { getPullRequestDiff, parseGitHubSource } from "@/lib/server/github";

export const runtime = "nodejs";
export const maxDuration = 90;

const requestSchema = z.object({
  diff: z.string().max(500_000).optional(),
  pullRequestUrl: z.string().url(),
});

const stepSchema = z.object({
  action: z.enum(["goto", "click", "fill", "expectVisible", "expectText", "expectValue", "expectValueContains", "expectUrl"]),
  selector: z.string().max(240),
  value: z.string().max(500),
  expected: z.string().max(500),
});

const planSchema = z.object({
  scenarios: z.array(z.object({
    title: z.string().min(1).max(120),
    purpose: z.string().min(1).max(300),
    steps: z.array(stepSchema).min(1).max(12),
  })).min(1).max(5),
});

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

function validatePlanTargets(scenarios: z.infer<typeof planSchema>["scenarios"]) {
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

    const response = await getOpenAIClient().responses.create({
      model: process.env.OPENAI_REVIEW_MODEL ?? "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: "Generate up to five focused browser regression scenarios for behavior changed by this patch. Return only structured test-plan data. Use only the allowed actions: goto, click, fill, expectVisible, expectText, expectValue, expectValueContains, expectUrl. Selectors must be CSS selectors grounded in the supplied source. goto values must be same-origin paths beginning with one slash. Never use external URLs, scripts, shell commands, or arbitrary code. Every step must include all four string fields; use empty strings for fields that do not apply.",
        },
        {
          role: "user",
          content: `REPOSITORY CONTEXT\n${context.map((item) => `FILE: ${item.path}\n${item.content}`).join("\n\n---\n\n")}\n\nPULL REQUEST DIFF\n${diff}`,
        },
      ],
      text: { format: { type: "json_schema", name: "playwright_regression_plan", strict: true, schema: outputSchema } },
    });
    if (!response.output_text) throw new Error("The model returned no regression test plan.");
    const plan = planSchema.parse(JSON.parse(response.output_text));
    validatePlanTargets(plan.scenarios);
    return NextResponse.json(plan);
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
