import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acceptFindings } from "../src/lib/server/review";

// R7 / R2 (evaluation/ROUND2.md): exports blind audit items. Items quote upstream BugsJS code, so they are written outside
// the repository (argv[2]); only a key mapping opaque ids to configurations is committed by the audit summary step.
type Range = { file: string; startLine: number; endLine: number };
type Finding = { file: string; line: number; title: string; severity: string; explanation: string; suggestion: string };
type ManifestCase = { project: string; bugId: number; defectLineRanges: Range[] };
const root = process.cwd();
const outputDirectory = resolve(process.argv[2] ?? join(tmpdir(), "diffsense-audit"));
const diffRoot = join(resolve(process.env.DIFFSENSE_BENCHMARK_CACHE ?? join(tmpdir(), "diffsense-benchmark-cache")), "diffs");
const caseId = (item: ManifestCase) => `${item.project}-${item.bugId}`.replace(/[^a-z0-9-]/gi, "-");
const slug = (item: ManifestCase) => `${item.project.replace(/[^a-z0-9]+/gi, "-")}-${item.bugId}`;

// Returns the diff hunks of `file` whose new-side lines overlap [start, end], capped in size.
function hunkExcerpt(diff: string, file: string, start: number, end: number) {
  const out: string[] = [];
  let path = "";
  let hunk: string[] = [];
  let newLine = 0;
  let hunkStart = 0;
  let hunkEnd = 0;
  const flush = () => {
    if (path === file && hunk.length && hunkEnd >= start - 3 && hunkStart <= end + 3) out.push(...hunk);
    hunk = [];
  };
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) { flush(); path = ""; continue; }
    if (line.startsWith("+++ ")) { path = line.startsWith("+++ b/") ? line.slice(6) : ""; continue; }
    if (line.startsWith("--- ")) continue;
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      flush();
      newLine = Number(header[1]);
      hunkStart = newLine;
      hunkEnd = newLine + Math.max(Number(header[2] ?? 1), 1) - 1;
      hunk = [line];
      continue;
    }
    if (hunk.length) hunk.push(line);
    if (line.startsWith("+") || line.startsWith(" ")) newLine += 1;
  }
  flush();
  return `--- ${file}\n${out.slice(0, 80).join("\n")}`;
}

const distance = (range: Range, line: number) => (line < range.startLine ? range.startLine - line : line > range.endLine ? line - range.endLine : 0);
function matchedFindings(ranges: Range[], findings: Finding[]) {
  const unmatched = [...findings];
  const matched: { range: Range; finding: Finding }[] = [];
  for (const range of ranges) {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    unmatched.forEach((candidate, index) => {
      const d = distance(range, candidate.line);
      if (candidate.file === range.file && d <= 2 && d < bestDistance) { best = index; bestDistance = d; }
    });
    if (best >= 0) matched.push({ range, finding: unmatched.splice(best, 1)[0] });
  }
  return matched;
}

const audit: { key: string; config: string; caseId: string; run: number; file: string; line: number; excerpt: string; finding: Omit<Finding, "file" | "line" | "severity"> }[] = [];
const sources = [
  ["holdout-baseline", "manifest-holdout.json", "holdout-baseline", "exact"],
  ["holdout-final-c4", "manifest-holdout.json", "holdout-final", "remap-removed"],
  ["dev-c3", "manifest.json", "dev-c3", "exact"],
] as const;
for (const [config, manifestFile, runDirectory, policy] of sources) {
  const manifest = JSON.parse(readFileSync(join(root, "evaluation", manifestFile), "utf8")) as { cases: ManifestCase[] };
  for (const item of manifest.cases) {
    const record = JSON.parse(readFileSync(join(root, "evaluation", "runs", "2026-10-05", runDirectory, `${caseId(item)}.json`), "utf8")) as { arms: { withContext: { rawFindings: Finding[] }[] } };
    const diff = readFileSync(join(diffRoot, `${slug(item)}.diff`), "utf8");
    record.arms.withContext.forEach((arm, runIndex) => {
      for (const { range, finding } of matchedFindings(item.defectLineRanges, acceptFindings(arm.rawFindings, diff, policy))) {
        audit.push({
          key: `${config}|${caseId(item)}|${runIndex + 1}|${finding.file}:${finding.line}`,
          config, caseId: caseId(item), run: runIndex + 1, file: finding.file, line: finding.line,
          excerpt: hunkExcerpt(diff, range.file, range.startLine, range.endLine),
          finding: { title: finding.title, explanation: finding.explanation, suggestion: finding.suggestion },
        });
      }
    });
  }
}

const flags: typeof audit = [];
const holdout = JSON.parse(readFileSync(join(root, "evaluation", "manifest-holdout.json"), "utf8")) as { cases: ManifestCase[] };
for (const [config, file] of [["forward-baseline", "falsealarms-holdout-forward-baseline.json"], ["forward-final", "falsealarms-holdout-forward-final.json"]] as const) {
  const result = JSON.parse(readFileSync(join(root, "evaluation", file), "utf8")) as { cases: { caseId: string; findings: Finding[] }[] };
  for (const entry of result.cases) {
    const item = holdout.cases.find((candidate) => caseId(candidate) === entry.caseId);
    if (!item) throw new Error(`Unknown case ${entry.caseId}.`);
    const diff = readFileSync(join(diffRoot, `${slug(item)}.forward.diff`), "utf8");
    for (const finding of entry.findings) {
      flags.push({
        key: `${config}|${entry.caseId}|1|${finding.file}:${finding.line}`,
        config, caseId: entry.caseId, run: 1, file: finding.file, line: finding.line,
        excerpt: hunkExcerpt(diff, finding.file, finding.line, finding.line),
        finding: { title: finding.title, explanation: finding.explanation, suggestion: finding.suggestion },
      });
    }
  }
}

// Blind ids: a hash of the key, and items ordered by that hash so configurations are interleaved.
const blind = (items: typeof audit, prefix: string) => items
  .map((item) => ({ id: `${prefix}-${createHash("sha256").update(item.key).digest("hex").slice(0, 10)}`, item }))
  .sort((left, right) => left.id.localeCompare(right.id));
const blindAudit = blind(audit, "m");
const blindFlags = blind(flags, "f");
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(join(outputDirectory, "audit-items.json"), JSON.stringify(blindAudit.map(({ id, item }) => ({ id, file: item.file, line: item.line, excerpt: item.excerpt, finding: item.finding })), null, 2));
writeFileSync(join(outputDirectory, "flag-items.json"), JSON.stringify(blindFlags.map(({ id, item }) => ({ id, file: item.file, line: item.line, excerpt: item.excerpt, finding: item.finding })), null, 2));
const key = [...blindAudit, ...blindFlags].map(({ id, item }) => ({ id, config: item.config, caseId: item.caseId, run: item.run, file: item.file, line: item.line }));
mkdirSync(join(root, "evaluation", "audit"), { recursive: true });
writeFileSync(join(root, "evaluation", "audit", "key.json"), `${JSON.stringify(key, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputDirectory, matchedFindings: blindAudit.length, forwardFlags: blindFlags.length, byConfig: key.reduce<Record<string, number>>((counts, item) => ({ ...counts, [item.config]: (counts[item.config] ?? 0) + 1 }), {}) }, null, 2));
