import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadEnvConfig } from "@next/env";
import protobuf from "protobufjs";

const datasetUrl = "https://github.com/BugsJS/bug-dataset.git";
const datasetRevision = "7abbad3e4df12cd5294110bb5db11b7d5bc758a6";
const repositoryRoot = resolve(process.cwd());
loadEnvConfig(repositoryRoot);
const cacheRoot = resolve(process.env.DIFFSENSE_BENCHMARK_CACHE ?? join(tmpdir(), "diffsense-benchmark-cache"));
const metadataPath = process.env.BUGSJS_DATASET_PATH ? resolve(process.env.BUGSJS_DATASET_PATH) : join(cacheRoot, "bug-dataset");
// DIFFSENSE_COHORT=holdout registers the second (HOLDOUT) cohort: the same ordered scan and rules, excluding the 30 DEV cases,
// with a fresh per-project cap, written to manifest-holdout.json. DEV's manifest.json is never modified.
const cohort = process.env.DIFFSENSE_COHORT ?? "dev";
if (cohort !== "dev" && cohort !== "holdout") throw new Error("DIFFSENSE_COHORT must be dev or holdout.");
const devManifestPath = join(repositoryRoot, "evaluation", "manifest.json");
const manifestPath = cohort === "holdout" ? join(repositoryRoot, "evaluation", "manifest-holdout.json") : devManifestPath;
const diffCachePath = join(cacheRoot, "diffs");
const targetCases = 30;
const maxPerProject = 6;
const initialLineLimit = 150;
const fallbackLineLimit = 200;
const maxIndexFiles = parsePositiveInteger(process.env.MAX_INDEX_FILES ?? "40", "MAX_INDEX_FILES");
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".cjs"]);
const testDirectories = new Set(["test", "tests", "__tests__", "spec", "specs"]);
const documentationDirectories = new Set(["doc", "docs", "documentation"]);
const generatedDirectories = new Set(["dist", "build", "vendor", "node_modules"]);
const documentationExtensions = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"]);
const configurationExtensions = new Set([".json", ".yaml", ".yml", ".toml", ".ini", ".lock", ".xml"]);

type RawBug = { id: number; origId: number; fix?: { hash?: string } };
type ProjectCandidate = {
  project: string;
  upstreamRepository: string;
  bugId: number;
  reportReferences: string[];
  fixSha: string | null;
  fixShas: string[];
};
type DefectRange = { file: string; startLine: number; endLine: number };
type CandidateDecision = ProjectCandidate & {
  status: "selected" | "rejected" | "not-inspected";
  diffInspected: boolean;
  reasons: string[];
  changedLines?: number;
  sourceFiles?: string[];
  defectLineRanges?: DefectRange[];
  buggySha?: string;
};
type ProjectSource = { name: string; repositoryUrl: string; bugCount: number };
type DiffFacts = { changedLines: number; sourceFiles: string[]; defectLineRanges: DefectRange[]; diff: string; buggySha: string };

function parsePositiveInteger(value: string, name: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function git(args: string[], cwd: string, maxBuffer = 20 * 1024 * 1024) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer, stdio: ["ignore", "pipe", "pipe"] });
}

function hasCommit(sha: string, cwd: string) {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function ordinalCompare(left: string, right: string) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

function isTestPath(filePath: string) {
  const parts = filePath.replaceAll("\\", "/").split("/").map((part) => part.toLowerCase());
  const name = basename(filePath).toLowerCase();
  return parts.some((part) => testDirectories.has(part)) || /\.(?:test|spec)\.[^.]+$/.test(name);
}

function isDocumentationPath(filePath: string) {
  const parts = filePath.replaceAll("\\", "/").split("/").map((part) => part.toLowerCase());
  return parts.some((part) => documentationDirectories.has(part)) || documentationExtensions.has(extname(filePath).toLowerCase());
}

function isConfigurationPath(filePath: string) {
  const name = basename(filePath).toLowerCase();
  return name.startsWith(".") || configurationExtensions.has(extname(name)) || name.includes("config");
}

function isSourcePath(filePath: string) {
  const parts = filePath.replaceAll("\\", "/").split("/").map((part) => part.toLowerCase());
  const name = basename(filePath).toLowerCase();
  return sourceExtensions.has(extname(name))
    && !parts.some((part) => testDirectories.has(part) || generatedDirectories.has(part))
    && !isTestPath(filePath)
    && !isDocumentationPath(filePath)
    && !isConfigurationPath(filePath);
}

async function ensureMetadataCheckout() {
  if (!(await pathExists(metadataPath))) {
    await mkdir(relative(cacheRoot, metadataPath).startsWith("..") ? metadataPath : cacheRoot, { recursive: true });
    git(["clone", "--depth", "1", datasetUrl, metadataPath], repositoryRoot);
  }
  const revision = git(["rev-parse", "HEAD"], metadataPath).trim();
  if (revision !== datasetRevision) throw new Error(`BugsJS metadata must be at pinned revision ${datasetRevision}; found ${revision}.`);
  return metadataPath;
}

async function readProjectSources(root: string): Promise<ProjectSource[]> {
  const rows = (await readFile(join(root, "Projects.csv"), "utf8")).trim().split(/\r?\n/).slice(1);
  return rows.map((row) => {
    const [name, repositoryUrl, count] = row.split(";");
    return { name, repositoryUrl, bugCount: Number(count) };
  }).sort((left, right) => ordinalCompare(left.name, right.name));
}

async function readCandidates(root: string) {
  const protoRoot = await protobuf.load(join(root, "project.proto"));
  const projectType = protoRoot.lookupType("bugjs.Project");
  const projects = await readProjectSources(root);
  const candidates: ProjectCandidate[] = [];

  for (const project of projects) {
    const records = await readFile(join(root, "Projects", project.name, `${project.name}_issues.bin`));
    const decoded = projectType.decode(records) as unknown as { bugs: RawBug[] };
    const grouped = new Map<number, RawBug[]>();
    for (const bug of decoded.bugs) {
      const group = grouped.get(bug.id) ?? [];
      group.push(bug);
      grouped.set(bug.id, group);
    }

    const csvLines = (await readFile(join(root, "Projects", project.name, `${project.name}_bugs.csv`), "utf8"))
      .trim()
      .split(/\r?\n/)
      .slice(1);
    const csvIds = new Set(csvLines.map((line) => Number(line.split(";", 1)[0])).filter(Number.isInteger));
    const metadataIds = new Set(grouped.keys());
    if (csvIds.size !== project.bugCount || metadataIds.size !== project.bugCount
      || [...csvIds].some((id) => !metadataIds.has(id))) {
      throw new Error(`BugsJS metadata counts do not reconcile for ${project.name}.`);
    }

    for (const bugId of [...csvIds].sort((left, right) => left - right)) {
      const reports = grouped.get(bugId) ?? [];
      const fixShas = [...new Set(reports.map((report) => report.fix?.hash).filter((sha): sha is string => Boolean(sha)))].sort();
      const reportIds = [...new Set(reports.map((report) => report.origId).filter((id) => id > 0))].sort((left, right) => left - right);
      candidates.push({
        project: project.name,
        upstreamRepository: project.repositoryUrl.replace(/\.git$/i, ""),
        bugId,
        reportReferences: reportIds.map((id) => `${project.repositoryUrl.replace(/\.git$/i, "")}/issues/${id}`),
        fixSha: fixShas.length === 1 ? fixShas[0] : null,
        fixShas,
      });
    }
  }

  if (candidates.length !== 453) throw new Error(`Expected 453 unique BugsJS bugs, found ${candidates.length}.`);
  return candidates;
}

async function ensureProjectClone(candidate: ProjectCandidate) {
  const slug = candidate.upstreamRepository.split("/").slice(-2).join("-").toLowerCase();
  const path = join(cacheRoot, "repos", slug);
  if (!(await pathExists(join(path, ".git")))) {
    await mkdir(join(cacheRoot, "repos"), { recursive: true });
    git(["clone", "--filter=blob:none", "--no-checkout", candidate.upstreamRepository, path], repositoryRoot, 50 * 1024 * 1024);
  }
  return path;
}

function mergeLineRanges(linesByFile: Map<string, number[]>): DefectRange[] {
  const ranges: DefectRange[] = [];
  for (const [file, lines] of [...linesByFile].sort(([left], [right]) => ordinalCompare(left, right))) {
    const sorted = [...new Set(lines)].sort((left, right) => left - right);
    if (sorted.length === 0) continue;
    let startLine = sorted[0];
    let endLine = sorted[0];
    for (const line of sorted.slice(1)) {
      if (line === endLine + 1) {
        endLine = line;
      } else {
        ranges.push({ file, startLine, endLine });
        startLine = line;
        endLine = line;
      }
    }
    ranges.push({ file, startLine, endLine });
  }
  return ranges;
}

function parseAddedSourceLines(diff: string, sourceFiles: Set<string>) {
  const linesByFile = new Map<string, number[]>();
  let currentFile = "";
  let currentLine = 0;
  let inHunk = false;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      inHunk = false;
    } else if (line.startsWith("+++ ")) {
      currentFile = "";
      inHunk = false;
    } else if (line.startsWith("@@")) {
      const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      currentLine = Number(match?.[1] ?? 0);
      inHunk = Boolean(match) && sourceFiles.has(currentFile);
    } else if (inHunk && line.startsWith("+") && !line.startsWith("+++")) {
      const added = linesByFile.get(currentFile) ?? [];
      added.push(currentLine);
      linesByFile.set(currentFile, added);
      currentLine += 1;
    } else if (inHunk && line.startsWith(" ")) {
      currentLine += 1;
    }
  }
  return mergeLineRanges(linesByFile);
}

async function inspectCandidate(candidate: ProjectCandidate, projectClones: Map<string, string>, fetchedShas: Set<string>): Promise<DiffFacts> {
  if (!candidate.fixSha) throw new Error(`Missing or conflicting fix SHA for ${candidate.project} bug ${candidate.bugId}.`);
  const repoPath = projectClones.get(candidate.upstreamRepository) ?? await ensureProjectClone(candidate);
  projectClones.set(candidate.upstreamRepository, repoPath);
  const fetchKey = `${candidate.upstreamRepository}:${candidate.fixSha}`;
  // A commit can be present only as a shallow boundary (fetched as another fix's parent), so require its parent too.
  if (!fetchedShas.has(fetchKey) && !(hasCommit(candidate.fixSha, repoPath) && hasCommit(`${candidate.fixSha}^`, repoPath))) {
    git(["fetch", "--depth=2", "--no-tags", "origin", candidate.fixSha], repoPath, 50 * 1024 * 1024);
  }
  fetchedShas.add(fetchKey);

  const buggySha = git(["rev-parse", `${candidate.fixSha}^`], repoPath).trim();
  const diffOptions = ["--no-ext-diff", "--no-renames", "--no-color", "--unified=0"];
  const revisions = [candidate.fixSha, buggySha];
  const changedPaths = git(["diff", ...diffOptions, "--name-only", "-z", ...revisions], repoPath).split("\0").filter(Boolean);
  const sourceFiles = [...new Set(changedPaths.filter(isSourcePath))].sort(ordinalCompare);
  const numstat = git(["diff", "--numstat", "--no-ext-diff", "--no-renames", "--no-color", ...revisions], repoPath, 50 * 1024 * 1024);
  let changedLines = 0;
  for (const row of numstat.split(/\r?\n/).filter(Boolean)) {
    const [added, deleted] = row.split("\t");
    if (added !== "-" && deleted !== "-") changedLines += Number(added) + Number(deleted);
  }
  if (!Number.isSafeInteger(changedLines) || changedLines < 0) throw new Error(`Invalid Git numstat for ${candidate.project} bug ${candidate.bugId}.`);
  const diff = git(["diff", ...diffOptions, ...revisions, "--"], repoPath, 50 * 1024 * 1024);
  const defectLineRanges = parseAddedSourceLines(diff, new Set(sourceFiles));
  return { changedLines, sourceFiles, defectLineRanges, diff, buggySha };
}

function exclusionReasons(candidate: ProjectCandidate, facts: DiffFacts | undefined, projectCount: number, lineLimit: number) {
  const reasons: string[] = [];
  if (projectCount >= maxPerProject) reasons.push("project_limit_reached");
  if (candidate.fixShas.length !== 1 || !candidate.fixSha) reasons.push("missing_or_conflicting_fix_sha");
  if (!facts) return reasons;
  if (facts.sourceFiles.length === 0) {
    reasons.push("no_eligible_non_test_javascript_source");
  } else if (facts.sourceFiles.length > 3) {
    reasons.push("more_than_three_non_test_source_files");
  }
  if (facts.changedLines > lineLimit) reasons.push(`more_than_${lineLimit}_changed_lines`);
  if (facts.defectLineRanges.length === 0) reasons.push("no_added_buggy_source_lines_to_label");
  return reasons;
}

async function scanCandidates(candidates: ProjectCandidate[], lineLimit: number) {
  const selected: CandidateDecision[] = [];
  const decisions: CandidateDecision[] = [];
  const projectClones = new Map<string, string>();
  const fetchedShas = new Set<string>();
  const projectCounts = new Map<string, number>();

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (selected.length >= targetCases) {
      decisions.push(...candidates.slice(index).map((remaining) => ({
        ...remaining,
        status: "not-inspected" as const,
        diffInspected: false,
        reasons: ["ordered_cohort_limit_reached"],
      })));
      break;
    }

    const projectCount = projectCounts.get(candidate.project) ?? 0;
    if (projectCount >= maxPerProject) {
      decisions.push({ ...candidate, status: "rejected", diffInspected: false, reasons: ["project_limit_reached"] });
      continue;
    }
    if (candidate.fixShas.length !== 1 || !candidate.fixSha) {
      decisions.push({ ...candidate, status: "rejected", diffInspected: false, reasons: ["missing_or_conflicting_fix_sha"] });
      continue;
    }

    const facts = await inspectCandidate(candidate, projectClones, fetchedShas);
    const reasons = exclusionReasons(candidate, facts, projectCount, lineLimit);
    const decision: CandidateDecision = {
      ...candidate,
      status: reasons.length === 0 ? "selected" : "rejected",
      diffInspected: true,
      reasons,
      changedLines: facts.changedLines,
      sourceFiles: facts.sourceFiles,
      defectLineRanges: facts.defectLineRanges,
      buggySha: facts.buggySha,
    };
    if (reasons.length === 0) {
      selected.push(decision);
      projectCounts.set(candidate.project, projectCount + 1);
      const diffPath = join(diffCachePath, `${candidate.project.replace(/[^a-z0-9]+/gi, "-")}-${candidate.bugId}.diff`);
      await mkdir(diffCachePath, { recursive: true });
      await writeFile(diffPath, facts.diff, "utf8");
    }
    decisions.push(decision);
  }

  return { selected, decisions };
}

async function assertNoExistingResults() {
  if (await pathExists(join(repositoryRoot, "evaluation", "results.json"))) {
    throw new Error("Refusing to rebuild benchmark labels after evaluation/results.json exists.");
  }
  const runsPath = join(repositoryRoot, "evaluation", "runs");
  if (await pathExists(runsPath) && (await readdir(runsPath)).length > 0) {
    throw new Error("Refusing to rebuild benchmark labels after raw benchmark runs exist.");
  }
}

async function main() {
  let excludedDevCases = 0;
  if (cohort === "holdout") {
    if (await pathExists(manifestPath)) throw new Error("manifest-holdout.json already exists; refusing to re-register the HOLDOUT cohort.");
  } else {
    await assertNoExistingResults();
  }
  const sourceRoot = await ensureMetadataCheckout();
  let candidates = await readCandidates(sourceRoot);
  if (cohort === "holdout") {
    const dev = JSON.parse(await readFile(devManifestPath, "utf8")) as { cases: { project: string; bugId: number }[] };
    const devKeys = new Set(dev.cases.map((item) => `${item.project}#${item.bugId}`));
    const before = candidates.length;
    candidates = candidates.filter((candidate) => !devKeys.has(`${candidate.project}#${candidate.bugId}`));
    excludedDevCases = before - candidates.length;
    if (excludedDevCases !== dev.cases.length) throw new Error(`Expected to exclude ${dev.cases.length} DEV cases, excluded ${excludedDevCases}.`);
  }
  const distinctFixes = new Set(candidates.map((candidate) => `${candidate.upstreamRepository}:${candidate.fixSha}`).filter(Boolean));
  console.log(`DATASET BUDGET: 0 model API calls, 0 tokens; at most ${distinctFixes.size} fix-SHA fetches and 10 project clones.`);

  let lineLimit = initialLineLimit;
  let fallbackApplied = false;
  let result = await scanCandidates(candidates, lineLimit);
  if (result.selected.length < targetCases) {
    lineLimit = fallbackLineLimit;
    fallbackApplied = true;
    result = await scanCandidates(candidates, lineLimit);
  }
  if (result.selected.length < targetCases) {
    throw new Error(`Only ${result.selected.length} candidates qualify after the single ${fallbackLineLimit}-line fallback; no manifest was written. Stop and review the shortfall.`);
  }

  const manifest = {
    schemaVersion: 1,
    dataset: {
      name: "BugsJS",
      repository: "https://github.com/BugsJS/bug-dataset",
      revision: datasetRevision,
      version: "1.0",
      license: "MIT",
      advertisedBugCount: candidates.length,
    },
    selection: {
      policy: "evaluation/SELECTION.md",
      cohort: cohort === "holdout" ? "HOLDOUT" : "DEV",
      ...(cohort === "holdout" ? { holdoutRule: "Same candidate order and eligibility rules as DEV, restarted from the first candidate, excluding the 30 DEV cases; per-project cap of 6 counted within HOLDOUT only. Registered before any HOLDOUT review run.", excludedDevCases } : {}),
      selectedCases: result.selected.length,
      totalCandidates: candidates.length,
      diffsInspected: result.decisions.filter((decision) => decision.diffInspected).length,
      initialChangedLineLimit: initialLineLimit,
      changedLineLimitUsed: lineLimit,
      fallbackApplied,
      maxBugsPerProject: maxPerProject,
      maxIndexFiles,
      fileClassification: "Committed policy in evaluation/SELECTION.md",
      candidatesResolvedByRules: result.decisions.filter((decision) => decision.status === "rejected").length,
    },
    cases: result.selected.map((candidate) => ({
      project: candidate.project,
      upstreamRepository: candidate.upstreamRepository,
      bugId: candidate.bugId,
      reportReferences: candidate.reportReferences,
      fixSha: candidate.fixSha,
      buggySha: candidate.buggySha,
      changedLines: candidate.changedLines,
      sourceFiles: candidate.sourceFiles,
      defectLineRanges: candidate.defectLineRanges,
    })),
    rejectedCandidates: result.decisions.filter((decision) => decision.status === "rejected"),
    notInspectedCandidates: result.decisions.filter((decision) => decision.status === "not-inspected"),
    diffCache: "Diff files are stored outside the repository in DIFFSENSE_BENCHMARK_CACHE/diffs (OS temp by default).",
  };

  await mkdir(join(repositoryRoot, "evaluation"), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const counts = result.selected.reduce<Record<string, number>>((accumulator, item) => {
    accumulator[item.project] = (accumulator[item.project] ?? 0) + 1;
    return accumulator;
  }, {});
  console.log(JSON.stringify({ selected: result.selected.length, changedLineLimit: lineLimit, fallbackApplied, selectedByProject: counts, rejectedCandidates: manifest.rejectedCandidates.length, notInspectedCandidates: manifest.notInspectedCandidates.length, manifestPath, diffCachePath }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Dataset construction failed.");
  process.exitCode = 1;
});
