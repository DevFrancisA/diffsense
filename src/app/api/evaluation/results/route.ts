import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const runSchema = z.object({
  runNumber: z.number().int().positive(),
  metrics: z.object({
    pullRequests: z.number().int().nonnegative(),
    knownDefects: z.number().int().nonnegative(),
    assistedDefectsFound: z.number().int().nonnegative(),
    falsePositives: z.number().int().nonnegative(),
    precision: z.number().min(0).max(1).nullable(),
    recall: z.number().min(0).max(1).nullable(),
  }),
});

const resultsSchema = z.object({
  benchmarkDate: z.string(),
  selection: z.object({ selectedCases: z.number().int().nonnegative(), maxIndexFiles: z.number().int().positive() }),
  models: z.object({ review: z.string(), embedding: z.string() }),
  arms: z.object({
    withContext: z.array(runSchema),
    withoutContext: z.array(runSchema),
  }),
  manualReview: z.object({ status: z.string(), reason: z.string() }),
  regressionEvaluation: z.object({ status: z.string(), reason: z.string() }),
}).passthrough();

function getRange(values: (number | null)[]) {
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (present.length === 0) return null;
  return { min: Math.min(...present), max: Math.max(...present) };
}

export async function GET() {
  try {
    const contents = await readFile(join(process.cwd(), "evaluation", "results.json"), "utf8");
    const results = resultsSchema.parse(JSON.parse(contents));
    return NextResponse.json({
      available: true,
      date: results.benchmarkDate,
      cohort: results.selection.selectedCases,
      maxIndexFiles: results.selection.maxIndexFiles,
      reviewModel: results.models.review,
      withContext: {
        runs: results.arms.withContext.map((run) => ({
          runNumber: run.runNumber,
          precision: run.metrics.precision,
          recall: run.metrics.recall,
          falsePositives: run.metrics.falsePositives,
        })),
        precisionRange: getRange(results.arms.withContext.map((run) => run.metrics.precision)),
        recallRange: getRange(results.arms.withContext.map((run) => run.metrics.recall)),
      },
      withoutContext: results.arms.withoutContext.map((run) => ({
        runNumber: run.runNumber,
        precision: run.metrics.precision,
        recall: run.metrics.recall,
        falsePositives: run.metrics.falsePositives,
      })),
      manualReview: results.manualReview,
      regressionEvaluation: results.regressionEvaluation,
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return NextResponse.json({ available: false, message: "No results yet." });
    }
    return NextResponse.json({ error: "Evaluation results are invalid or unavailable." }, { status: 500 });
  }
}
