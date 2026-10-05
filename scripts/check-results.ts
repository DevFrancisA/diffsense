import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// CI gate: every committed results file must parse with the evaluator, and stored metrics must equal recomputed ones.
const root = process.cwd();
const evaluationRoot = join(root, "evaluation");
const failures: string[] = [];

type Metrics = { precision: number | null; recall: number | null; assistedDefectsFound: number; falsePositives: number; knownDefects: number };
type Arm = { runNumber: number; metrics: Metrics };

const benchmarkFiles = readdirSync(evaluationRoot).filter((name) => /^results(-[a-z0-9-]+)?\.json$/.test(name));
for (const name of benchmarkFiles) {
  const filePath = join(evaluationRoot, name);
  const result = spawnSync(process.execPath, [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, "scripts", "evaluate.ts"), filePath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    failures.push(`${name}: evaluator rejected the file: ${result.stderr.trim()}`);
    continue;
  }
  const recomputed = JSON.parse(result.stdout) as { arms: Record<"withContext" | "withoutContext", ({ runNumber: number } & Metrics)[]> };
  const stored = JSON.parse(readFileSync(filePath, "utf8")) as { arms: { withContext: Arm[]; withoutContext: Arm[] } };
  for (const arm of ["withContext", "withoutContext"] as const) {
    stored.arms[arm].forEach((run, index) => {
      const fresh = recomputed.arms[arm][index];
      for (const key of ["precision", "recall", "assistedDefectsFound", "falsePositives", "knownDefects"] as const) {
        if (fresh?.[key] !== run.metrics[key]) failures.push(`${name}: ${arm} run ${run.runNumber} ${key} stored ${run.metrics[key]} but recomputes to ${fresh?.[key]}`);
      }
    });
  }
  console.log(`ok ${name}`);
}

const regressionResultsPath = join(evaluationRoot, "regressions", "results.json");
if (existsSync(regressionResultsPath)) {
  const status = z.enum(["detected", "not-detected", "invalid-plan", "infra-invalid"]);
  const schema = z.object({
    schemaVersion: z.literal(1),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
    summary: z.object({
      scenariosAttempted: z.number().int().nonnegative(),
      validScenarios: z.number().int().nonnegative(),
      replacedForInfrastructure: z.number().int().nonnegative(),
      detected: z.number().int().nonnegative(),
      notDetected: z.number().int().nonnegative(),
      invalidPlans: z.number().int().nonnegative(),
      validPlans: z.number().int().nonnegative(),
      detectedOverValidScenarios: z.number().min(0).max(1).nullable(),
      detectedOverValidPlans: z.number().min(0).max(1).nullable(),
    }),
    scenarios: z.array(z.object({ id: z.string(), status })),
  }).passthrough();
  const parsed = schema.safeParse(JSON.parse(readFileSync(regressionResultsPath, "utf8")));
  if (!parsed.success) {
    failures.push(`regressions/results.json: ${parsed.error.message}`);
  } else {
    const { summary, scenarios } = parsed.data;
    const runsDirectory = join(evaluationRoot, "regressions", "runs");
    for (const scenario of scenarios) {
      const record = JSON.parse(readFileSync(join(runsDirectory, `${scenario.id}.json`), "utf8")) as { status: string };
      if (record.status !== scenario.status) failures.push(`regressions: ${scenario.id} summary says ${scenario.status}, run record says ${record.status}`);
    }
    const count = (value: string) => scenarios.filter((scenario) => scenario.status === value).length;
    const expected = {
      scenariosAttempted: scenarios.length,
      validScenarios: scenarios.length - count("infra-invalid"),
      replacedForInfrastructure: count("infra-invalid"),
      detected: count("detected"),
      notDetected: count("not-detected"),
      invalidPlans: count("invalid-plan"),
    };
    for (const [key, value] of Object.entries(expected)) {
      if (summary[key as keyof typeof expected] !== value) failures.push(`regressions: summary.${key} is ${summary[key as keyof typeof expected]}, records give ${value}`);
    }
    console.log("ok regressions/results.json");
  }
}

// Forward-fix false-alarm files: the summary must equal the per-case findings it is built from.
for (const name of readdirSync(evaluationRoot).filter((file) => /^falsealarms-[a-z0-9-]+\.json$/.test(file))) {
  const schema = z.object({
    kind: z.literal("forward-fix-false-alarms"),
    summary: z.object({ cases: z.number().int(), casesFlagged: z.number().int(), casesFlaggedOnSource: z.number().int(), findings: z.number().int(), sourceFindings: z.number().int(), testFindings: z.number().int() }),
    cases: z.array(z.object({ caseId: z.string(), findings: z.array(z.object({ file: z.string(), line: z.number().int(), isTest: z.boolean() }).passthrough()) }).passthrough()),
  }).passthrough();
  const parsed = schema.safeParse(JSON.parse(readFileSync(join(evaluationRoot, name), "utf8")));
  if (!parsed.success) { failures.push(`${name}: ${parsed.error.message}`); continue; }
  const { summary, cases } = parsed.data;
  const findings = cases.flatMap((item) => item.findings);
  const expected = {
    cases: cases.length,
    casesFlagged: cases.filter((item) => item.findings.length > 0).length,
    casesFlaggedOnSource: cases.filter((item) => item.findings.some((finding) => !finding.isTest)).length,
    findings: findings.length,
    sourceFindings: findings.filter((finding) => !finding.isTest).length,
    testFindings: findings.filter((finding) => finding.isTest).length,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (summary[key as keyof typeof expected] !== value) failures.push(`${name}: summary.${key} is ${summary[key as keyof typeof expected]}, cases give ${value}`);
  }
  console.log(`ok ${name}`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
