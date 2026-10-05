import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// DEV/HOLDOUT comparison from committed results files (no API calls):
// per-run recall/precision with Wilson 95% intervals, precision split by source vs test files, paired HOLDOUT analysis
// (per-range 2x2, exact McNemar, case-clustered bootstrap), and forward-fix false alarms.
type Range = { file: string; startLine: number; endLine: number };
type Finding = { file: string; line: number };
type PullRequest = { id: string; knownDefects: Range[]; assistedFindings: Finding[] };
type Run = { runNumber: number; pullRequests: PullRequest[]; metrics: { assistedDefectsFound: number; knownDefects: number; falsePositives: number; findings: { assisted: number } } };
const root = join(process.cwd(), "evaluation");
const testPath = /(?:^|\/)(?:test|tests|__tests__|spec|specs)\/|\.(?:test|spec)\.[^/]+$/i;

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
const rate = (successes: number, trials: number) => (trials ? `${percent(successes / trials)} (${interval(wilson(successes, trials))})` : "n/a");

const distance = (range: Range, line: number) => (line < range.startLine ? range.startLine - line : line > range.endLine ? line - range.endLine : 0);
// Mirrors countMatchedFindings in src/lib/evaluation.ts: which ranges are found, and which findings are unmatched.
function match(pullRequest: PullRequest) {
  const unmatched = [...pullRequest.assistedFindings];
  const found = pullRequest.knownDefects.map((range) => {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    unmatched.forEach((candidate, index) => {
      const d = distance(range, candidate.line);
      if (candidate.file === range.file && d <= 2 && d < bestDistance) { best = index; bestDistance = d; }
    });
    if (best >= 0) unmatched.splice(best, 1);
    return best >= 0;
  });
  return { found, falsePositives: unmatched };
}

const configs = [
  ["DEV", "baseline", "results.json"],
  ["DEV", "C1", "results-dev-c1.json"],
  ["DEV", "C2", "results-dev-c2.json"],
  ["DEV", "C3", "results-dev-c3.json"],
  ["DEV", "C4 = C3 + remap", "results-dev-c4.json"],
  ["HOLDOUT", "baseline", "results-holdout-baseline.json"],
  ["HOLDOUT", "C3", "results-holdout-final.json"],
  ["HOLDOUT", "baseline + remap", "results-holdout-baseline-remap.json"],
  ["HOLDOUT", "C4 (final)", "results-holdout-final-c4.json"],
] as const;
const loaded = new Map<string, Run[]>();
const rows: Record<string, unknown>[] = [];
const lines = [
  "| Cohort | Config | Run | Found / labeled | Predictions | FP (source / test) | Recall (Wilson 95%) | Precision (Wilson 95%) | Source-file precision |",
  "|---|---|---:|---:|---:|---|---|---|---|",
];
for (const [cohort, config, file] of configs) {
  const path = join(root, file);
  if (!existsSync(path)) continue;
  const runs = (JSON.parse(readFileSync(path, "utf8")) as { arms: { withContext: Run[] } }).arms.withContext;
  loaded.set(file, runs);
  for (const run of runs) {
    const { assistedDefectsFound: found, knownDefects: known } = run.metrics;
    const predictions = run.metrics.findings.assisted;
    const falsePositives = run.pullRequests.flatMap((pullRequest) => match(pullRequest).falsePositives);
    const testFalsePositives = falsePositives.filter((finding) => testPath.test(finding.file)).length;
    const sourcePredictions = run.pullRequests.flatMap((pullRequest) => pullRequest.assistedFindings).filter((finding) => !testPath.test(finding.file)).length;
    const sourceFalsePositives = falsePositives.length - testFalsePositives;
    rows.push({ cohort, config, file, run: run.runNumber, found, known, predictions, falsePositives: falsePositives.length, sourceFalsePositives, testFalsePositives, sourcePredictions });
    lines.push(`| ${cohort} | ${config} | ${run.runNumber} | ${found} / ${known} | ${predictions} | ${falsePositives.length} (${sourceFalsePositives} / ${testFalsePositives}) | ${rate(found, known)} | ${rate(found, predictions)} | ${rate(sourcePredictions - sourceFalsePositives, sourcePredictions)} |`);
  }
}

// Deterministic PRNG so the bootstrap is reproducible.
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function binomialTwoSided(k: number, n: number) {
  if (n === 0) return 1;
  let tail = 0;
  let coefficient = 1;
  for (let i = 0; i <= n; i += 1) {
    if (i > 0) coefficient = (coefficient * (n - i + 1)) / i;
    if (i <= Math.min(k, n - k)) tail += coefficient;
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}
function paired(baseFile: string, otherFile: string) {
  const base = loaded.get(baseFile)?.[0];
  const other = loaded.get(otherFile)?.[0];
  if (!base || !other) return null;
  const perCase = base.pullRequests.map((pullRequest) => {
    const counterpart = other.pullRequests.find((item) => item.id === pullRequest.id);
    if (!counterpart) throw new Error(`Case ${pullRequest.id} missing from ${otherFile}.`);
    return { id: pullRequest.id, ranges: pullRequest.knownDefects.length, base: match(pullRequest).found, other: match(counterpart).found };
  });
  const cells = { both: 0, baseOnly: 0, otherOnly: 0, neither: 0 };
  for (const item of perCase) {
    item.base.forEach((found, index) => {
      const otherFound = item.other[index];
      if (found && otherFound) cells.both += 1;
      else if (found) cells.baseOnly += 1;
      else if (otherFound) cells.otherOnly += 1;
      else cells.neither += 1;
    });
  }
  const discordant = cells.baseOnly + cells.otherOnly;
  const random = mulberry32(20261005);
  const differences: number[] = [];
  for (let iteration = 0; iteration < 10_000; iteration += 1) {
    let ranges = 0;
    let delta = 0;
    for (let draw = 0; draw < perCase.length; draw += 1) {
      const item = perCase[Math.floor(random() * perCase.length)];
      ranges += item.ranges;
      delta += item.other.filter(Boolean).length - item.base.filter(Boolean).length;
    }
    differences.push(ranges ? delta / ranges : 0);
  }
  differences.sort((left, right) => left - right);
  const totalRanges = perCase.reduce((total, item) => total + item.ranges, 0);
  return {
    base: baseFile,
    other: otherFile,
    cells,
    mcnemarExactP: binomialTwoSided(Math.min(cells.baseOnly, cells.otherOnly), discordant),
    recallDifference: (cells.otherOnly - cells.baseOnly) / totalRanges,
    bootstrap95: { low: differences[249], high: differences[9_749] },
  };
}
const pairs = [paired("results-holdout-baseline.json", "results-holdout-final.json"), paired("results-holdout-baseline-remap.json", "results-holdout-final-c4.json"), paired("results-holdout-baseline.json", "results-holdout-final-c4.json")].filter(Boolean);
lines.push("", "| HOLDOUT pair (run 1 each) | Both | Base only | Other only | Neither | Recall difference | Bootstrap 95% CI | Exact McNemar p |", "|---|---:|---:|---:|---:|---:|---|---:|");
for (const pair of pairs) {
  if (!pair) continue;
  lines.push(`| ${pair.base} → ${pair.other} | ${pair.cells.both} | ${pair.cells.baseOnly} | ${pair.cells.otherOnly} | ${pair.cells.neither} | ${percent(pair.recallDifference)} | ${percent(pair.bootstrap95.low)} to ${percent(pair.bootstrap95.high)} | ${pair.mcnemarExactP.toFixed(3)} |`);
}

const falseAlarms: Record<string, unknown>[] = [];
lines.push("", "| Forward-fix arm (HOLDOUT, correct code) | Cases flagged | Cases flagged on source | Findings (source / test) |", "|---|---|---|---|");
for (const [label, file] of [["baseline", "falsealarms-holdout-forward-baseline.json"], ["final (C4)", "falsealarms-holdout-forward-final.json"]]) {
  const path = join(root, file);
  if (!existsSync(path)) continue;
  const { summary: raw } = JSON.parse(readFileSync(path, "utf8")) as { summary: { cases: number; casesReviewed: number; casesFlagged: number; casesFlaggedOnSource: number; findings: number; sourceFindings: number; testFindings: number } };
  // Rates use reviewed cases: a fix that adds no lines is skipped without a review call.
  const summary = { ...raw, cases: raw.casesReviewed };
  falseAlarms.push({ label, file, ...summary, casesFlaggedWilson: wilson(summary.casesFlagged, summary.cases), casesFlaggedOnSourceWilson: wilson(summary.casesFlaggedOnSource, summary.cases) });
  lines.push(`| ${label} | ${summary.casesFlagged}/${summary.cases} = ${rate(summary.casesFlagged, summary.cases)} | ${summary.casesFlaggedOnSource}/${summary.cases} = ${rate(summary.casesFlaggedOnSource, summary.cases)} | ${summary.findings} (${summary.sourceFindings} / ${summary.testFindings}) |`);
}

writeFileSync(join(root, "comparison.json"), `${JSON.stringify({ interval: "Wilson score, 95%", bootstrap: "10,000 case resamples, seed 20261005, percentile", rows, pairs, falseAlarms }, null, 2)}\n`, "utf8");
console.log(lines.join("\n"));
