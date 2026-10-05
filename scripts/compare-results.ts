import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Builds the DEV vs HOLDOUT comparison table from committed results files, with Wilson 95% score intervals.
type Run = { runNumber: number; metrics: { assistedDefectsFound: number; knownDefects: number; falsePositives: number; findings: { assisted: number } } };
const root = join(process.cwd(), "evaluation");

function wilson(successes: number, trials: number, z = 1.959963984540054) {
  if (trials === 0) return null;
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = (p + (z * z) / (2 * trials)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / denominator;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const interval = (value: { low: number; high: number } | null) => (value ? `${percent(value.low)}–${percent(value.high)}` : "n/a");

const rows: Record<string, unknown>[] = [];
const files = [
  ["DEV", "baseline", "results.json"],
  ["DEV", "C1", "results-dev-c1.json"],
  ["DEV", "C2", "results-dev-c2.json"],
  ["DEV", "C3", "results-dev-c3.json"],
  ["HOLDOUT", "baseline", "results-holdout-baseline.json"],
  ["HOLDOUT", "final", "results-holdout-final.json"],
] as const;
const lines = ["| Cohort | Config | Run | Found / labeled | Predictions | FP | Recall (Wilson 95%) | Precision (Wilson 95%) |", "|---|---|---:|---:|---:|---:|---|---|"];
for (const [cohort, config, file] of files) {
  const path = join(root, file);
  if (!existsSync(path)) continue;
  const result = JSON.parse(readFileSync(path, "utf8")) as { arms: { withContext: Run[] } };
  for (const run of result.arms.withContext) {
    const { assistedDefectsFound: found, knownDefects: known, falsePositives: fp } = run.metrics;
    const predictions = run.metrics.findings.assisted;
    const recall = { value: found / known, ci: wilson(found, known) };
    const precision = predictions ? { value: found / predictions, ci: wilson(found, predictions) } : null;
    rows.push({ cohort, config, file, run: run.runNumber, found, known, predictions, falsePositives: fp, recall, precision });
    lines.push(`| ${cohort} | ${config} | ${run.runNumber} | ${found} / ${known} | ${predictions} | ${fp} | ${percent(recall.value)} (${interval(recall.ci)}) | ${precision ? `${percent(precision.value)} (${interval(precision.ci)})` : "n/a"} |`);
  }
}
writeFileSync(join(root, "comparison.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), interval: "Wilson score, 95%", rows }, null, 2)}\n`, "utf8");
console.log(lines.join("\n"));
