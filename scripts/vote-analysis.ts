import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../src/lib/evaluation";

// Round 4 (evaluation/ROUND4.md): scores "keep a finding seen in >= k of n samples" rules on the development set
// (DEV + HOLDOUT, reversed and forward arms) from saved one-run sample variants. No API calls.
// Usage: tsx scripts/vote-analysis.ts            (groups below; samples that do not exist yet are skipped)
type Range = { file: string; startLine: number; endLine: number };
type Finding = { file: string; line: number };
type ManifestCase = { project: string; bugId: number; defectLineRanges: Range[] };
type Group = { label: string; callsPerSample: number; reversed: Record<string, string[]>; forward: Record<string, string[]> };

const root = process.cwd();
const runsRoot = join(root, "evaluation", "runs", "2026-10-05");
const cohorts = { dev: "manifest.json", holdout: "manifest-holdout.json", test: "manifest-test.json" } as const;
const caseId = (item: ManifestCase) => `${item.project}-${item.bugId}`.replace(/[^a-z0-9-]/gi, "-");
const samples = (prefix: string, names: string[]) => names.map((name) => `${prefix}${name}`);

// Samples per model and cohort; the first gpt-4.1-mini pair is C7's two samples.
const groups: Group[] = [
  {
    label: "gpt-4.1-mini (C5 samples)",
    callsPerSample: 1,
    reversed: { dev: ["dev-c5", "dev-c5-r2"], holdout: ["holdout-c5", "holdout-c5-r2"], test: ["test-c5", "test-c5-r2"] },
    forward: { dev: ["dev-forward-c5", "dev-forward-c5-r2"], holdout: ["holdout-forward-c5", "holdout-forward-c5-r2"], test: ["test-forward-c5", "test-forward-c5-r2"] },
  },
  ...[["gpt-5.4-mini", "m54mini"], ["gpt-5.5", "m55"]].map(([label, tag]) => ({
    label,
    callsPerSample: 1,
    reversed: { dev: samples(`dev-${tag}`, ["", "-r2", "-r3"]), holdout: samples(`holdout-${tag}`, ["", "-r2", "-r3"]), test: samples(`test-${tag}`, ["", "-r2", "-r3"]) },
    forward: { dev: samples(`dev-forward-${tag}`, ["", "-r2", "-r3"]), holdout: samples(`holdout-forward-${tag}`, ["", "-r2", "-r3"]), test: samples(`test-forward-${tag}`, ["", "-r2", "-r3"]) },
  })),
];

function accepted(variant: string, id: string): Finding[] | null {
  const path = join(runsRoot, variant, `${id}.json`);
  if (!existsSync(path)) return null;
  const record = JSON.parse(readFileSync(path, "utf8")) as { complete?: boolean; arms: { withContext: { acceptedFindings: Finding[] }[] } };
  return record.complete === false ? null : record.arms.withContext[0]?.acceptedFindings ?? null;
}

function vote(lists: Finding[][], k: number) {
  const counts = new Map<string, { finding: Finding; count: number }>();
  for (const list of lists) {
    for (const key of new Set(list.map((finding) => `${finding.file}:${finding.line}`))) {
      const entry = counts.get(key) ?? { finding: list.find((finding) => `${finding.file}:${finding.line}` === key) as Finding, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].filter((entry) => entry.count >= k).map((entry) => entry.finding);
}

// Scores one rule (first n samples, threshold k) on the given cohorts; null if any needed sample is missing.
export function scoreRule(group: Group, n: number, k: number, cohortNames: (keyof typeof cohorts)[]) {
  let found = 0; let ranges = 0; let reversedFindings = 0; let forwardFindings = 0; let fixesFlagged = 0; let fixes = 0;
  for (const cohort of cohortNames) {
    const manifest = JSON.parse(readFileSync(join(root, "evaluation", cohorts[cohort]), "utf8")) as { cases: ManifestCase[] };
    const reversedVariants = (group.reversed[cohort] ?? []).slice(0, n);
    const forwardVariants = (group.forward[cohort] ?? []).slice(0, n);
    if (reversedVariants.length < n || forwardVariants.length < n) return null;
    const pullRequests = [];
    for (const item of manifest.cases) {
      const id = caseId(item);
      const reversedLists = reversedVariants.map((variant) => accepted(variant, id));
      const forwardLists = forwardVariants.map((variant) => accepted(variant, id));
      if (reversedLists.some((list) => list === null) || forwardLists.some((list) => list === null)) return null;
      const kept = vote(reversedLists as Finding[][], k);
      pullRequests.push({ id, knownDefects: item.defectLineRanges, assistedFindings: kept.map(({ file, line }) => ({ file, line })) });
      const flags = vote(forwardLists as Finding[][], k);
      forwardFindings += flags.length;
      fixes += 1;
      if (flags.length > 0) fixesFlagged += 1;
    }
    const metrics = evaluate({ pullRequests, regressionScenarios: [] });
    found += metrics.assistedDefectsFound;
    ranges += metrics.knownDefects;
    reversedFindings += metrics.findings.assisted;
  }
  const recall = ranges ? found / ranges : 0;
  const combinedPrecision = reversedFindings + forwardFindings ? found / (reversedFindings + forwardFindings) : 0;
  const f1 = recall + combinedPrecision ? (2 * recall * combinedPrecision) / (recall + combinedPrecision) : 0;
  return { found, ranges, recall, reversedFindings, forwardFindings, combinedPrecision, f1, fixesFlagged, fixes, callsPerDiff: n * group.callsPerSample };
}

if (process.argv[1]?.endsWith("vote-analysis.ts")) {
  const cohortNames = (process.argv[2] ?? "dev,holdout").split(",") as (keyof typeof cohorts)[];
  const rows: Record<string, unknown>[] = [];
  const lines = [`Cohorts: ${cohortNames.join(" + ")}`, "| Model | n | k | Found / ranges | Recall | Findings (bug / correct) | Combined precision | Combined F1 | Correct fixes flagged |", "|---|---:|---:|---:|---:|---|---:|---:|---:|"];
  for (const group of groups) {
    for (let n = 1; n <= 3; n += 1) {
      for (let k = 1; k <= n; k += 1) {
        const score = scoreRule(group, n, k, cohortNames);
        if (!score) continue;
        rows.push({ model: group.label, n, k, ...score });
        lines.push(`| ${group.label} | ${n} | ${k} | ${score.found} / ${score.ranges} | ${(score.recall * 100).toFixed(1)}% | ${score.reversedFindings} / ${score.forwardFindings} | ${(score.combinedPrecision * 100).toFixed(1)}% | ${score.f1.toFixed(3)} | ${score.fixesFlagged} / ${score.fixes} |`);
      }
    }
  }
  writeFileSync(join(root, "evaluation", `round4-voting-${cohortNames.join("-")}.json`), `${JSON.stringify({ cohorts: cohortNames, identity: "file:line", rows }, null, 2)}\n`, "utf8");
  console.log(lines.join("\n"));
}
