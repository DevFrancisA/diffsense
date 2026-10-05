import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../src/lib/evaluation";

// C7 (evaluation/ROUND3.md): unites the accepted findings of two independent one-run samples of the same configuration,
// de-duplicated by file and line. No API calls.
// Usage: tsx scripts/union-runs.ts <variant A> <variant B> <output variant>
type Range = { file: string; startLine: number; endLine: number };
type Finding = { file: string; line: number; [key: string]: unknown };
type ManifestCase = { project: string; bugId: number; defectLineRanges: Range[] };
type CaseRecord = { caseId: string; pipelineConfig: { manifest: string; direction?: string }; arms: { withContext: { acceptedFindings: Finding[]; skipped?: string }[] } };

const [variantA, variantB, outputVariant] = process.argv.slice(2);
if (!variantA || !variantB || !outputVariant) throw new Error("Usage: union-runs.ts <variant A> <variant B> <output variant>");
const root = process.cwd();
const runsRoot = join(root, "evaluation", "runs", "2026-10-05");
const testPath = /(?:^|\/)(?:test|tests|__tests__|spec|specs)\/|\.(?:test|spec)\.[^/]+$/i;
const read = (variant: string, id: string) => JSON.parse(readFileSync(join(runsRoot, variant, `${id}.json`), "utf8")) as CaseRecord;

const sample = JSON.parse(readFileSync(join(root, "evaluation", "manifest.json"), "utf8")) as { cases: ManifestCase[] };
const firstId = `${sample.cases[0].project}-${sample.cases[0].bugId}`.replace(/[^a-z0-9-]/gi, "-");
let manifestFile = "manifest.json";
try { manifestFile = read(variantA, firstId).pipelineConfig.manifest; } catch { manifestFile = "manifest-holdout.json"; }
const manifest = JSON.parse(readFileSync(join(root, "evaluation", manifestFile), "utf8")) as { cases: ManifestCase[] };

let forward = false;
const united = manifest.cases.map((item) => {
  const id = `${item.project}-${item.bugId}`.replace(/[^a-z0-9-]/gi, "-");
  const [a, b] = [read(variantA, id), read(variantB, id)];
  if (a.pipelineConfig.direction !== b.pipelineConfig.direction) throw new Error(`${id}: the two samples differ in direction.`);
  forward = a.pipelineConfig.direction === "forward";
  const seen = new Set<string>();
  const findings = [...a.arms.withContext[0].acceptedFindings, ...b.arms.withContext[0].acceptedFindings].filter((finding) => {
    const key = `${finding.file}:${finding.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { item, id, findings, skipped: a.arms.withContext[0].skipped ?? null };
});

const derivedFrom = { samples: [variantA, variantB], method: "scripts/union-runs.ts (union of accepted findings, de-duplicated by file:line)" };
if (forward) {
  const cases = united.map(({ id, findings, skipped }) => ({ caseId: id, skipped, findings: findings.map((finding) => ({ ...finding, isTest: testPath.test(finding.file) })) }));
  const all = cases.flatMap((entry) => entry.findings);
  const output = {
    schemaVersion: 1,
    kind: "forward-fix-false-alarms",
    benchmarkVariant: outputVariant,
    derivedFrom,
    summary: {
      cases: cases.length,
      casesReviewed: cases.filter((entry) => !entry.skipped).length,
      casesFlagged: cases.filter((entry) => entry.findings.length > 0).length,
      casesFlaggedOnSource: cases.filter((entry) => entry.findings.some((finding) => !finding.isTest)).length,
      findings: all.length,
      sourceFindings: all.filter((finding) => !finding.isTest).length,
      testFindings: all.filter((finding) => finding.isTest).length,
    },
    cases,
  };
  writeFileSync(join(root, "evaluation", `falsealarms-${outputVariant}.json`), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(output.summary));
} else {
  const source = JSON.parse(readFileSync(join(root, "evaluation", `results-${variantA}.json`), "utf8")) as Record<string, unknown>;
  const pullRequests = united.map(({ item, id, findings }) => ({ id, knownDefects: item.defectLineRanges, assistedFindings: findings.map(({ file, line }) => ({ file, line })) }));
  const metrics = evaluate({ pullRequests, regressionScenarios: [] });
  const output = { ...source, benchmarkVariant: outputVariant, derivedFrom, arms: { withContext: [{ runNumber: 1, pullRequests, metrics }], withoutContext: [] } };
  writeFileSync(join(root, "evaluation", `results-${outputVariant}.json`), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ found: metrics.assistedDefectsFound, predictions: metrics.findings.assisted, falsePositives: metrics.falsePositives }));
}
