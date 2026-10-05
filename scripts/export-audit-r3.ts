import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Round 3 blind audit export (same rubric as R7): HOLDOUT C7 matched findings and C7 flags on correct fixes.
// C7 findings are the union of its two samples, so finding text is taken from the sample that produced each finding.
// Items quote upstream code and are written outside the repository (argv[2]); the id key is committed.
type Range = { file: string; startLine: number; endLine: number };
type Finding = { file: string; line: number; title: string; explanation: string; suggestion: string; failureAfterChange?: string };
type ManifestCase = { project: string; bugId: number; defectLineRanges: Range[] };
const root = process.cwd();
const outputDirectory = resolve(process.argv[2] ?? join(tmpdir(), "diffsense-audit-r3"));
const diffRoot = join(resolve(process.env.DIFFSENSE_BENCHMARK_CACHE ?? join(tmpdir(), "diffsense-benchmark-cache")), "diffs");
const runsRoot = join(root, "evaluation", "runs", "2026-10-05");
const manifest = JSON.parse(readFileSync(join(root, "evaluation", "manifest-holdout.json"), "utf8")) as { cases: ManifestCase[] };
const caseId = (item: ManifestCase) => `${item.project}-${item.bugId}`.replace(/[^a-z0-9-]/gi, "-");

function hunkExcerpt(diff: string, file: string, start: number, end: number) {
  const out: string[] = [];
  let path = "";
  let hunk: string[] = [];
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
      hunkStart = Number(header[1]);
      hunkEnd = hunkStart + Math.max(Number(header[2] ?? 1), 1) - 1;
      hunk = [line];
      continue;
    }
    if (hunk.length) hunk.push(line);
  }
  flush();
  return `--- ${file}\n${out.slice(0, 80).join("\n")}`;
}

function unitedFindings(variants: string[], id: string) {
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const variant of variants) {
    const record = JSON.parse(readFileSync(join(runsRoot, variant, `${id}.json`), "utf8")) as { arms: { withContext: { acceptedFindings: Finding[] }[] } };
    for (const finding of record.arms.withContext[0].acceptedFindings) {
      const key = `${finding.file}:${finding.line}`;
      if (!seen.has(key)) { seen.add(key); findings.push(finding); }
    }
  }
  return findings;
}

const distance = (range: Range, line: number) => (line < range.startLine ? range.startLine - line : line > range.endLine ? line - range.endLine : 0);
type Item = { key: string; config: string; caseId: string; file: string; line: number; excerpt: string; finding: Omit<Finding, "file" | "line"> };
const audit: Item[] = [];
const flags: Item[] = [];
for (const item of manifest.cases) {
  const id = caseId(item);
  const reversed = readFileSync(join(diffRoot, `${id}.diff`), "utf8");
  const unmatched = unitedFindings(["holdout-c5", "holdout-c5-r2"], id);
  for (const range of item.defectLineRanges) {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    unmatched.forEach((candidate, index) => {
      const d = distance(range, candidate.line);
      if (candidate.file === range.file && d <= 2 && d < bestDistance) { best = index; bestDistance = d; }
    });
    if (best < 0) continue;
    const { file, line, ...finding } = unmatched.splice(best, 1)[0];
    audit.push({ key: `holdout-c7|${id}|${file}:${line}`, config: "holdout-c7", caseId: id, file, line, excerpt: hunkExcerpt(reversed, range.file, range.startLine, range.endLine), finding });
  }
  const forward = readFileSync(join(diffRoot, `${id}.forward.diff`), "utf8");
  for (const { file, line, ...finding } of unitedFindings(["holdout-forward-c5", "holdout-forward-c5-r2"], id)) {
    flags.push({ key: `forward-c7|${id}|${file}:${line}`, config: "forward-c7", caseId: id, file, line, excerpt: hunkExcerpt(forward, file, line, line), finding });
  }
}

const blind = (items: Item[], prefix: string) => items
  .map((item) => ({ id: `${prefix}-${createHash("sha256").update(item.key).digest("hex").slice(0, 10)}`, item }))
  .sort((left, right) => left.id.localeCompare(right.id));
const blindAudit = blind(audit, "m3");
const blindFlags = blind(flags, "f3");
mkdirSync(outputDirectory, { recursive: true });
const strip = ({ id, item }: { id: string; item: Item }) => ({ id, file: item.file, line: item.line, excerpt: item.excerpt, finding: item.finding });
writeFileSync(join(outputDirectory, "audit-items.json"), JSON.stringify(blindAudit.map(strip), null, 2));
writeFileSync(join(outputDirectory, "flag-items.json"), JSON.stringify(blindFlags.map(strip), null, 2));
const key = [...blindAudit, ...blindFlags].map(({ id, item }) => ({ id, config: item.config, caseId: item.caseId, run: 1, file: item.file, line: item.line }));
writeFileSync(join(root, "evaluation", "audit", "key-r3.json"), `${JSON.stringify(key, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ matched: blindAudit.length, flags: blindFlags.length, auditIds: blindAudit.map((entry) => entry.id), flagIds: blindFlags.map((entry) => entry.id) }));
