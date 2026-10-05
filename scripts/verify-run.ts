import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadEnvConfig } from "@next/env";
import { evaluate } from "../src/lib/evaluation";
import { applyDiffToFile, getChangedFileContext } from "../src/lib/server/context";
import { verifierPromptHash, verifyFindings } from "../src/lib/server/verify";
import { createSessionBudget } from "./session-budget";

loadEnvConfig(process.cwd());

// C6 (evaluation/ROUND3.md): runs the verifier over a saved C5 variant's accepted findings and writes a derived variant.
// Usage: tsx scripts/verify-run.ts <source variant> <output variant>
// Reversed variants produce results-<output>.json; forward variants produce falsealarms-<output>.json.
type Range = { file: string; startLine: number; endLine: number };
type Finding = { title: string; severity: string; file: string; line: number; explanation: string; suggestion: string; failureAfterChange?: string };
type ManifestCase = { project: string; bugId: number; defectLineRanges: Range[] };
type CaseRecord = {
  caseId: string; upstreamRepository: string; index: { commitSha: string };
  pipelineConfig: { manifest: string; direction?: string };
  arms: { withContext: { acceptedFindings: Finding[]; skipped?: string }[] };
};

const [sourceVariant, outputVariant] = process.argv.slice(2);
if (!sourceVariant || !outputVariant) throw new Error("Usage: verify-run.ts <source variant> <output variant>");
const root = process.cwd();
const runsRoot = join(root, "evaluation", "runs", "2026-10-05");
const diffRoot = join(resolve(process.env.DIFFSENSE_BENCHMARK_CACHE ?? join(tmpdir(), "diffsense-benchmark-cache")), "diffs");
const testPath = /(?:^|\/)(?:test|tests|__tests__|spec|specs)\/|\.(?:test|spec)\.[^/]+$/i;

async function run() {
  const sourceDirectory = join(runsRoot, sourceVariant);
  const outputDirectory = join(runsRoot, outputVariant);
  mkdirSync(outputDirectory, { recursive: true });
  const budget = await createSessionBudget(`verify/${outputVariant}`);
  const records: CaseRecord[] = [];
  let manifestFile = "";
  let forward = false;
  for (const manifestName of ["manifest.json", "manifest-holdout.json"]) {
    const manifest = JSON.parse(readFileSync(join(root, "evaluation", manifestName), "utf8")) as { cases: ManifestCase[] };
    for (const item of manifest.cases) {
      const id = `${item.project}-${item.bugId}`.replace(/[^a-z0-9-]/gi, "-");
      const path = join(sourceDirectory, `${id}.json`);
      if (!existsSync(path)) continue;
      const record = JSON.parse(readFileSync(path, "utf8")) as CaseRecord;
      manifestFile = record.pipelineConfig.manifest;
      forward = record.pipelineConfig.direction === "forward";
      records.push(record);
    }
  }
  if (records.length !== 30) throw new Error(`Expected 30 case records in ${sourceVariant}, found ${records.length}.`);
  const manifest = JSON.parse(readFileSync(join(root, "evaluation", manifestFile), "utf8")) as { cases: ManifestCase[] };
  const runCount = records[0].arms.withContext.length;

  const verified = new Map<string, Finding[][]>();
  for (const record of records) {
    const outputPath = join(outputDirectory, `${record.caseId}.json`);
    const existing = existsSync(outputPath) ? JSON.parse(readFileSync(outputPath, "utf8")) as { verifierPromptHash: string; runs: { kept: Finding[] }[] } : null;
    if (existing && existing.verifierPromptHash === verifierPromptHash && existing.runs.length === runCount) {
      verified.set(record.caseId, existing.runs.map((runResult) => runResult.kept));
      continue;
    }
    const [owner, repository] = record.upstreamRepository.split("/").slice(-2);
    const diff = readFileSync(join(diffRoot, `${record.caseId}${forward ? ".forward" : ""}.diff`), "utf8");
    const files = (await getChangedFileContext(owner, repository, record.index.commitSha, diff, { excludeTests: true }))
      .map((file) => ({ path: `${file.path} (full file after this change)`, content: applyDiffToFile(diff, file.path, file.content) }))
      .filter((file): file is { path: string; content: string } => file.content !== null);
    const runs = [];
    for (const arm of record.arms.withContext) {
      const result = await verifyFindings(diff, files, arm.acceptedFindings, budget);
      runs.push({ input: arm.acceptedFindings.length, kept: result.kept, verdicts: result.verdicts, usage: result.usage });
    }
    writeFileSync(outputPath, `${JSON.stringify({ caseId: record.caseId, sourceVariant, verifierPromptHash, runs }, null, 2)}\n`, "utf8");
    verified.set(record.caseId, runs.map((runResult) => runResult.kept));
    console.log(`VERIFIED ${record.caseId}: ${runs.map((runResult) => `${runResult.kept.length}/${runResult.input}`).join(" ")}`);
  }

  if (forward) {
    const cases = records.map((record) => ({
      caseId: record.caseId,
      skipped: record.arms.withContext[0].skipped ?? null,
      findings: (verified.get(record.caseId)?.[0] ?? []).map((finding) => ({ ...finding, isTest: testPath.test(finding.file) })),
    }));
    const all = cases.flatMap((item) => item.findings);
    const output = {
      schemaVersion: 1,
      kind: "forward-fix-false-alarms",
      benchmarkVariant: outputVariant,
      derivedFrom: { variant: sourceVariant, method: "scripts/verify-run.ts (C6 verifier over saved accepted findings)", verifierPromptHash },
      summary: {
        cases: cases.length,
        casesReviewed: cases.filter((item) => !item.skipped).length,
        casesFlagged: cases.filter((item) => item.findings.length > 0).length,
        casesFlaggedOnSource: cases.filter((item) => item.findings.some((finding) => !finding.isTest)).length,
        findings: all.length,
        sourceFindings: all.filter((finding) => !finding.isTest).length,
        testFindings: all.filter((finding) => finding.isTest).length,
      },
      cases,
    };
    writeFileSync(join(root, "evaluation", `falsealarms-${outputVariant}.json`), `${JSON.stringify(output, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(output.summary));
    return;
  }

  const source = JSON.parse(readFileSync(join(root, "evaluation", `results-${sourceVariant}.json`), "utf8")) as Record<string, unknown>;
  const withContext = Array.from({ length: runCount }, (_, runIndex) => {
    const pullRequests = manifest.cases.map((item) => {
      const id = `${item.project}-${item.bugId}`.replace(/[^a-z0-9-]/gi, "-");
      return { id, knownDefects: item.defectLineRanges, assistedFindings: (verified.get(id)?.[runIndex] ?? []).map(({ file, line }) => ({ file, line })) };
    });
    return { runNumber: runIndex + 1, pullRequests, metrics: evaluate({ pullRequests, regressionScenarios: [] }) };
  });
  const output = {
    ...source,
    benchmarkVariant: outputVariant,
    derivedFrom: { results: `results-${sourceVariant}.json`, method: "scripts/verify-run.ts (C6 verifier over saved accepted findings)", verifierPromptHash },
    arms: { withContext, withoutContext: [] },
  };
  writeFileSync(join(root, "evaluation", `results-${outputVariant}.json`), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(withContext.map((runResult) => ({ run: runResult.runNumber, found: runResult.metrics.assistedDefectsFound, predictions: runResult.metrics.findings.assisted }))));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
