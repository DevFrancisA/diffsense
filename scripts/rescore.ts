import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluate } from "../src/lib/evaluation";
import { type AcceptancePolicy, acceptFindings } from "../src/lib/server/review";

// Re-applies an acceptance policy to saved raw findings (no API calls).
// Usage: tsx scripts/rescore.ts <source-results-file> <policy> [<output-variant>]
// With policy "exact" it only verifies that the committed accepted findings and metrics are reproduced.
type Range = { file: string; startLine: number; endLine: number };
type Finding = { file: string; line: number };
type ManifestCase = { project: string; bugId: number; defectLineRanges: Range[] };
type CaseRecord = { caseId: string; diffSha256: string; arms: { withContext: { rawFindings: Finding[]; acceptedFindings: Finding[] }[] } };
type Results = {
  benchmarkVariant?: string;
  pipelineConfig?: Record<string, unknown>;
  arms: { withContext: { runNumber: number; metrics: { assistedDefectsFound: number; falsePositives: number } }[]; withoutContext: unknown[] };
  [key: string]: unknown;
};

const root = process.cwd();
const [sourceFile, policyArgument, outputVariant] = process.argv.slice(2);
if (!sourceFile || (policyArgument !== "exact" && policyArgument !== "remap-removed")) throw new Error("Usage: rescore.ts <results file> <exact|remap-removed> [output variant]");
const policy = policyArgument as AcceptancePolicy;
const diffRoot = join(resolve(process.env.DIFFSENSE_BENCHMARK_CACHE ?? join(tmpdir(), "diffsense-benchmark-cache")), "diffs");
const source = JSON.parse(readFileSync(join(root, "evaluation", sourceFile), "utf8")) as Results;
const variant = source.benchmarkVariant ?? "baseline";
const manifestFile = (source.pipelineConfig?.manifest as string | undefined) ?? "manifest.json";
const manifest = JSON.parse(readFileSync(join(root, "evaluation", manifestFile), "utf8")) as { cases: ManifestCase[] };
const runDirectory = join(root, "evaluation", "runs", "2026-10-05", ...(variant === "baseline" ? [] : [variant]));

const distance = (range: Range, line: number) => (line < range.startLine ? range.startLine - line : line > range.endLine ? line - range.endLine : 0);
// Mirrors countMatchedFindings in src/lib/evaluation.ts, returning which finding each range consumed.
function matches(ranges: Range[], findings: (Finding & { remappedFrom?: number })[]) {
  const unmatched = [...findings];
  return ranges.map((range) => {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    unmatched.forEach((candidate, index) => {
      const d = distance(range, candidate.line);
      if (candidate.file === range.file && d <= 2 && d < bestDistance) { best = index; bestDistance = d; }
    });
    return best >= 0 ? unmatched.splice(best, 1)[0] : null;
  });
}

const runCount = source.arms.withContext.length;
const pullRequestsByRun: { id: string; knownDefects: Range[]; assistedFindings: Finding[] }[][] = Array.from({ length: runCount }, () => []);
const exactPullRequestsByRun: typeof pullRequestsByRun = Array.from({ length: runCount }, () => []);
const remappedMatches = Array.from({ length: runCount }, () => 0);
const remappedFindings = Array.from({ length: runCount }, () => 0);
for (const item of manifest.cases) {
  const id = `${item.project}-${item.bugId}`.replace(/[^a-z0-9-]/gi, "-");
  const record = JSON.parse(readFileSync(join(runDirectory, `${id}.json`), "utf8")) as CaseRecord;
  const diff = readFileSync(join(diffRoot, `${item.project.replace(/[^a-z0-9]+/gi, "-")}-${item.bugId}.diff`), "utf8");
  if (createHash("sha256").update(diff).digest("hex") !== record.diffSha256) throw new Error(`${id}: cached diff does not match the run record.`);
  record.arms.withContext.forEach((arm, runIndex) => {
    const exact = acceptFindings(arm.rawFindings, diff, "exact").map(({ file, line }) => `${file}:${line}`);
    const stored = arm.acceptedFindings.map(({ file, line }) => `${file}:${line}`);
    if (JSON.stringify(exact) !== JSON.stringify(stored)) throw new Error(`${id} run ${runIndex + 1}: exact policy does not reproduce the stored accepted findings.`);
    exactPullRequestsByRun[runIndex].push({ id, knownDefects: item.defectLineRanges, assistedFindings: arm.acceptedFindings.map(({ file, line }) => ({ file, line })) });
    const accepted = acceptFindings(arm.rawFindings, diff, policy);
    remappedFindings[runIndex] += accepted.filter((finding) => finding.remappedFrom !== undefined).length;
    remappedMatches[runIndex] += matches(item.defectLineRanges, accepted).filter((finding) => finding?.remappedFrom !== undefined).length;
    pullRequestsByRun[runIndex].push({ id, knownDefects: item.defectLineRanges, assistedFindings: accepted.map(({ file, line }) => ({ file, line })) });
  });
}

const withContext = pullRequestsByRun.map((pullRequests, index) => ({ runNumber: index + 1, pullRequests, metrics: evaluate({ pullRequests, regressionScenarios: [] }) }));
// Whatever the policy, the current evaluator must first reproduce the committed metrics from the committed accepted findings.
exactPullRequestsByRun.forEach((pullRequests, index) => {
  const fresh = evaluate({ pullRequests, regressionScenarios: [] });
  const committed = source.arms.withContext[index].metrics as { assistedDefectsFound: number; falsePositives: number; findings?: { assisted: number } };
  if (fresh.assistedDefectsFound !== committed.assistedDefectsFound || fresh.falsePositives !== committed.falsePositives || fresh.findings.assisted !== committed.findings?.assisted) {
    throw new Error(`Run ${index + 1}: exact re-score does not reproduce the committed metrics.`);
  }
});
const summary = withContext.map((run, index) => ({ run: run.runNumber, found: run.metrics.assistedDefectsFound, predictions: run.metrics.findings.assisted, falsePositives: run.metrics.falsePositives, remappedFindings: remappedFindings[index], matchesFromRemappedFindings: remappedMatches[index] }));
console.log(JSON.stringify({ source: sourceFile, policy, summary }, null, 2));

if (policy !== "exact" && outputVariant) {
  const output = {
    ...source,
    benchmarkVariant: outputVariant,
    derivedFrom: { results: sourceFile, method: "scripts/rescore.ts: saved raw findings re-accepted with a different acceptance policy; no new model calls" },
    pipelineConfig: { ...source.pipelineConfig, acceptance: policy },
    arms: { withContext, withoutContext: [] },
    remapping: summary,
  };
  writeFileSync(join(root, "evaluation", `results-${outputVariant}.json`), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Wrote evaluation/results-${outputVariant}.json`);
}
