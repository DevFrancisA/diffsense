import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadEnvConfig } from "@next/env";
import { evaluate } from "../src/lib/evaluation";

loadEnvConfig(process.cwd());

// Post-hoc classification of every defect range the baseline context arm missed. Reads saved outputs only; no OpenAI calls.
// GitHub tree listings are fetched to reconstruct which files the 40-file index cap admitted.
type Range = { file: string; startLine: number; endLine: number };
type Finding = { file: string; line: number };
type ManifestCase = { project: string; bugId: number; defectLineRanges: Range[] };
type RunRecord = {
  caseId: string;
  diffSha256: string;
  index: { repository: string; commitSha: string; maxFiles: number; filesIndexed: number };
  context: { chunkRefs: { path: string }[] };
  arms: { withContext: { rawFindings: Finding[]; acceptedFindings: Finding[] }[] };
};

const root = process.cwd();
const runDirectory = join(root, "evaluation", "runs", process.env.DIFFSENSE_RUN_DATE ?? "2026-10-05");
const diffRoot = join(resolve(process.env.DIFFSENSE_BENCHMARK_CACHE ?? join(tmpdir(), "diffsense-benchmark-cache")), "diffs");
const manifest = JSON.parse(readFileSync(join(root, "evaluation", "manifest.json"), "utf8")) as { cases: ManifestCase[] };
const results = JSON.parse(readFileSync(join(root, "evaluation", "results.json"), "utf8")) as { arms: { withContext: { runNumber: number; metrics: { assistedDefectsFound: number } }[] } };

// Same rule as the indexer in src/lib/server/context.ts.
const supportedSource = /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|mjs|php|py|rb|rs|sql|svelte|ts|tsx|vue)$/i;
const ignoredPath = /(?:^|\/)(?:node_modules|vendor|dist|build|\.next|coverage|\.git|\.venv)(?:\/|$)|(?:\.min\.|\.lock\.)/i;

function distance(range: Range, line: number) {
  return line < range.startLine ? range.startLine - line : line > range.endLine ? line - range.endLine : 0;
}

// Mirrors countMatchedFindings in src/lib/evaluation.ts, but returns which ranges were consumed and by which finding.
function matchRanges(ranges: Range[], findings: Finding[]) {
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

async function indexedFiles(repository: string, commitSha: string, maxFiles: number) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "DiffSense", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  const response = await fetch(`https://api.github.com/repos/${repository}/git/trees/${commitSha}?recursive=1`, { headers });
  if (!response.ok) throw new Error(`GitHub tree request failed for ${repository}@${commitSha}: ${response.status}`);
  const tree = (await response.json()) as { truncated: boolean; tree: { path: string; type: string; size?: number }[] };
  if (tree.truncated) throw new Error(`Tree for ${repository}@${commitSha} is truncated.`);
  return new Set(tree.tree
    .filter((entry) => entry.type === "blob" && (entry.size ?? 0) <= 80_000)
    .filter((entry) => supportedSource.test(entry.path) && !ignoredPath.test(entry.path))
    .slice(0, maxFiles)
    .map((entry) => entry.path));
}

// Character offset at which each new-file line appears in the diff, to test the 12,000-character retrieval query cut-off.
function lineOffsets(diff: string) {
  const offsets = new Map<string, number>();
  let file = "";
  let newLine = 0;
  let offset = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) file = line.slice(6);
    else if (line.startsWith("@@")) newLine = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
    else if (file && !line.startsWith("---") && !line.startsWith("diff --git") && !line.startsWith("index ")) {
      if (line.startsWith("+") || line.startsWith(" ")) { offsets.set(`${file}:${newLine}`, offset); newLine += 1; }
    }
    offset += line.length + 1;
  }
  return offsets;
}

type Miss = {
  caseId: string;
  run: number;
  range: Range;
  category: "wrong-line" | "outside-index-cap" | "not-retrieved" | "retrieved-silent";
  subcategory: string;
  firstPassCategory: "wrong-line" | "outside-index-cap" | "not-retrieved" | "retrieved-silent";
  rangeBeyondRetrievalQuery: boolean | null;
};

async function main() {
  const misses: Miss[] = [];
  const matchedPerRun = [0, 0, 0];
  let totalRanges = 0;
  for (const item of manifest.cases) {
    const caseId = `${item.project}-${item.bugId}`.replace(/[^a-z0-9-]/gi, "-");
    const record = JSON.parse(readFileSync(join(runDirectory, `${caseId}.json`), "utf8")) as RunRecord;
    const indexed = await indexedFiles(record.index.repository, record.index.commitSha, record.index.maxFiles);
    if (indexed.size !== record.index.filesIndexed) throw new Error(`${caseId}: reconstructed ${indexed.size} indexed files, run recorded ${record.index.filesIndexed}.`);
    const retrieved = new Set(record.context.chunkRefs.map((chunk) => chunk.path));
    const diffPath = join(diffRoot, `${item.project.replace(/[^a-z0-9]+/gi, "-")}-${item.bugId}.diff`);
    let offsets: Map<string, number> | null = null;
    if (existsSync(diffPath)) {
      const diff = readFileSync(diffPath, "utf8");
      if (createHash("sha256").update(diff).digest("hex") !== record.diffSha256) throw new Error(`${caseId}: cached diff hash mismatch.`);
      offsets = lineOffsets(diff);
    }
    totalRanges += item.defectLineRanges.length;

    record.arms.withContext.forEach((arm, runIndex) => {
      const matches = matchRanges(item.defectLineRanges, arm.acceptedFindings);
      matchedPerRun[runIndex] += matches.filter(Boolean).length;
      const consumed = new Set(matches.filter((finding): finding is Finding => finding !== null));
      item.defectLineRanges.forEach((range, rangeIndex) => {
        if (matches[rangeIndex]) return;
        const firstLineOffset = offsets?.get(`${range.file}:${range.startLine}`);
        const rangeBeyondRetrievalQuery = firstLineOffset === undefined ? null : firstLineOffset >= 12_000;
        const sameFileRaw = arm.rawFindings.filter((finding) => finding.file === range.file);
        const nearRaw = sameFileRaw.filter((finding) => distance(range, finding.line) <= 2);
        const nearAcceptedConsumed = arm.acceptedFindings.filter((finding) => finding.file === range.file && distance(range, finding.line) <= 2 && consumed.has(finding));
        // Far same-file findings that the evaluator matched to a different range target that range, not this one.
        const consumedKeys = new Set([...consumed].map((finding) => `${finding.file}:${finding.line}`));
        const farUnattributed = sameFileRaw.filter((finding) => distance(range, finding.line) > 2 && !consumedKeys.has(`${finding.file}:${finding.line}`));
        const otherRangeFound = sameFileRaw.some((finding) => consumedKeys.has(`${finding.file}:${finding.line}`));
        const note = otherRangeFound ? " (another range in this file was found)" : "";
        let category: Miss["category"];
        let subcategory: string;
        if (nearAcceptedConsumed.length > 0) { category = "wrong-line"; subcategory = "nearby finding already matched to an adjacent range (one-to-one)"; }
        else if (nearRaw.length > 0) { category = "wrong-line"; subcategory = "nearby raw finding rejected by the exact-added-line gate"; }
        else if (farUnattributed.length > 0) { category = "wrong-line"; subcategory = "unmatched finding in the same file more than 2 lines away"; }
        else if (!indexed.has(range.file)) { category = "outside-index-cap"; subcategory = `defect file not among indexed files${note}`; }
        else if (!retrieved.has(range.file)) { category = "not-retrieved"; subcategory = `defect file indexed but no chunk of it retrieved${note}`; }
        else { category = "retrieved-silent"; subcategory = `defect file retrieved; no finding targeting this range${note}`; }
        const firstPassCategory: Miss["category"] = nearRaw.length > 0 || sameFileRaw.length > 0 ? "wrong-line" : category;
        misses.push({ caseId, run: runIndex + 1, range, category, subcategory, firstPassCategory, rangeBeyondRetrievalQuery });
      });
    });
  }

  // Cross-check against the committed metrics so the miss set is exactly what the evaluator scored.
  results.arms.withContext.forEach((run, index) => {
    if (run.metrics.assistedDefectsFound !== matchedPerRun[index]) throw new Error(`Run ${run.runNumber}: matched ${matchedPerRun[index]}, results.json says ${run.metrics.assistedDefectsFound}.`);
  });
  void evaluate;

  const tally = (rows: Miss[], key: (miss: Miss) => string) => rows.reduce<Record<string, number>>((counts, miss) => ({ ...counts, [key(miss)]: (counts[key(miss)] ?? 0) + 1 }), {});
  const uniqueKey = (miss: Miss) => `${miss.caseId}|${miss.range.file}|${miss.range.startLine}-${miss.range.endLine}`;
  const missCountByRange = tally(misses, uniqueKey);
  const missedInAllRuns = misses.filter((miss) => miss.run === 1 && missCountByRange[uniqueKey(miss)] === 3);
  const output = {
    generatedAt: new Date().toISOString(),
    source: "evaluation/runs/2026-10-05 with-context runs 1-3 (baseline prompt b60c051b...)",
    totalRanges,
    matchedPerRun,
    missesPerRun: matchedPerRun.map((matched) => totalRanges - matched),
    byCategory: tally(misses, (miss) => miss.category),
    byFirstPassCategory: tally(misses, (miss) => miss.firstPassCategory),
    bySubcategory: tally(misses, (miss) => `${miss.category}: ${miss.subcategory}`),
    byCategoryPerRun: [1, 2, 3].map((run) => tally(misses.filter((miss) => miss.run === run), (miss) => miss.category)),
    missedInAllThreeRuns: { count: missedInAllRuns.length, byCategoryInRun1: tally(missedInAllRuns, (miss) => miss.category) },
    rangeBeyondFirst12000DiffChars: tally(misses, (miss) => String(miss.rangeBeyondRetrievalQuery)),
    misses,
  };
  writeFileSync(join(root, "evaluation", "error-analysis.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  const { misses: _omitted, ...summary } = output;
  void _omitted;
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
