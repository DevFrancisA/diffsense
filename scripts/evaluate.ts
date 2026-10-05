import { readFile } from "node:fs/promises";
import { z } from "zod";
import { evaluate, evaluateBenchmarkArms, evaluationSchema } from "../src/lib/evaluation";

const benchmarkRunSchema = z.object({
  runNumber: z.number().int().positive(),
  pullRequests: evaluationSchema.shape.pullRequests,
}).passthrough();

const benchmarkResultsSchema = z.object({
  schemaVersion: z.literal(1),
  benchmarkDate: z.string(),
  arms: z.object({
    withContext: z.array(benchmarkRunSchema),
    withoutContext: z.array(benchmarkRunSchema),
  }),
}).passthrough();

async function main() {
  const filePath = process.argv[2];
  if (!filePath) throw new Error("Usage: npm run evaluate -- path/to/evaluation.json");
  const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  const benchmark = benchmarkResultsSchema.safeParse(raw);
  const result = benchmark.success
    ? { ...benchmark.data, arms: evaluateBenchmarkArms(benchmark.data.arms) }
    : evaluate(evaluationSchema.parse(raw));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Evaluation failed."}\n`);
  process.exitCode = 1;
});
