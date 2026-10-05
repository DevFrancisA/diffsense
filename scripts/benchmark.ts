import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadEnvConfig } from "@next/env";
import { createSessionBudget } from "./session-budget";

loadEnvConfig(process.cwd());

const root = process.cwd();
const manifestFile = process.env.DIFFSENSE_MANIFEST ?? "manifest.json";
if (!["manifest.json", "manifest-holdout.json", "manifest-test.json"].includes(manifestFile)) throw new Error("DIFFSENSE_MANIFEST must be manifest.json (DEV), manifest-holdout.json (HOLDOUT), or manifest-test.json (TEST).");
const manifestPath = join(root, "evaluation", manifestFile);
const cacheRoot = resolve(process.env.DIFFSENSE_BENCHMARK_CACHE ?? join(tmpdir(), "diffsense-benchmark-cache"));
const diffRoot = join(cacheRoot, "diffs");
const runsRoot = join(root, "evaluation", "runs");
const runDate = process.env.DIFFSENSE_RUN_DATE ?? new Date().toISOString().slice(0, 10);
const runVariant = process.env.DIFFSENSE_BENCHMARK_VARIANT ?? "baseline";
const includeNoContext = process.env.DIFFSENSE_NO_CONTEXT !== "false";
const withContextRuns = Number(process.env.DIFFSENSE_RUNS ?? 3);
if (!Number.isSafeInteger(withContextRuns) || withContextRuns < 1 || withContextRuns > 3) throw new Error("DIFFSENSE_RUNS must be 1, 2, or 3.");
// Post-baseline variants are fully described by this configuration; it is stored with every case and result.
const pipelineConfig = {
  manifest: manifestFile,
  promptRevision: (process.env.REVIEW_PROMPT_REVISION ?? "baseline") as "baseline" | "cite-added-line" | "cite-added-line-source-focus" | "post-change",
  includeChangedFiles: process.env.DIFFSENSE_INCLUDE_CHANGED_FILES === "true",
  ...(process.env.DIFFSENSE_CHANGED_FILES_EXCLUDE_TESTS === "true" ? { changedFilesExcludeTests: true } : {}),
  retrievalK: Number(process.env.DIFFSENSE_RETRIEVAL_K ?? 8),
  maxIndexFiles: Number(process.env.MAX_INDEX_FILES ?? 40),
  withContextRuns,
  // Added in Round 2; omitted when at their defaults so earlier variants' stored configs stay identical.
  ...(process.env.DIFFSENSE_ACCEPTANCE === "remap-removed" ? { acceptance: "remap-removed" as const } : {}),
  ...(process.env.DIFFSENSE_DIFF_DIRECTION === "forward" ? { direction: "forward" as const } : {}),
  ...(process.env.DIFFSENSE_CHANGED_FILE_SIDE === "after" ? { changedFileSide: "after" as const } : {}),
};
const forward = pipelineConfig.direction === "forward";
if (!["baseline", "cite-added-line", "cite-added-line-source-focus", "post-change"].includes(pipelineConfig.promptRevision)) throw new Error("Unknown REVIEW_PROMPT_REVISION.");
if (!Number.isSafeInteger(pipelineConfig.retrievalK) || pipelineConfig.retrievalK < 1 || pipelineConfig.retrievalK > 32) throw new Error("DIFFSENSE_RETRIEVAL_K must be 1-32.");

if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate) || Number.isNaN(Date.parse(`${runDate}T00:00:00Z`))) {
  throw new Error("DIFFSENSE_RUN_DATE must use YYYY-MM-DD.");
}
if (!/^[a-z0-9-]+$/i.test(runVariant)) throw new Error("DIFFSENSE_BENCHMARK_VARIANT may contain only letters, numbers, and hyphens.");

type ManifestCase = {
  project: string;
  upstreamRepository: string;
  bugId: number;
  reportReferences: string[];
  fixSha: string;
  buggySha: string;
  changedLines: number;
  sourceFiles: string[];
  defectLineRanges: { file: string; startLine: number; endLine: number }[];
};

type Manifest = {
  schemaVersion: number;
  dataset: { revision: string; repository: string };
  selection: { selectedCases: number; maxIndexFiles: number };
  cases: ManifestCase[];
};

type Finding = {
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number;
  explanation: string;
  suggestion: string;
  failureAfterChange?: string;
  alreadyFixedByChange?: boolean;
};

type TokenUsage = { inputTokens: number; outputTokens: number; totalTokens: number };
type StoredReview = {
  model: string;
  promptHash: string;
  usage: TokenUsage;
  rawFindings: Finding[];
  acceptedFindings: Finding[];
};
type StoredCase = {
  schemaVersion: number;
  runDate: string;
  caseId: string;
  project: string;
  bugId: number;
  upstreamRepository: string;
  fixedSha: string;
  buggySha: string;
  manifestSha256: string;
  diffSha256: string;
  pipelineConfig?: typeof pipelineConfig;
  model: string;
  embeddingModel: string;
  promptHash: string;
  index: {
    repository: string;
    commitSha: string;
    maxFiles: number;
    filesIndexed: number;
    chunksIndexed: number;
    embeddingUsage: TokenUsage;
  };
  context: {
    changedFileRefs?: { path: string; contentSha256: string }[];
    chunkRefs: { path: string; contentSha256: string }[];
    embeddingUsage: TokenUsage;
  };
  arms: {
    withContext: StoredReview[];
    withoutContext: StoredReview | null;
  };
  complete: boolean;
};

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function caseId(item: ManifestCase) {
  return `${item.project}-${item.bugId}`.replace(/[^a-z0-9-]/gi, "-");
}

function diffPath(item: ManifestCase) {
  const slug = item.project.replace(/[^a-z0-9]+/gi, "-");
  // Forward diffs (buggy -> fix) are written by scripts/forward-diffs.ts; reversed diffs (fix -> buggy) by build-dataset.
  return join(diffRoot, forward ? `${slug}-${item.bugId}.forward.diff` : `${slug}-${item.bugId}.diff`);
}

function clipText(value: string, lineLimit = 3, charLimit = 500) {
  return value.split(/\r?\n/).slice(0, lineLimit).join("\n").slice(0, charLimit);
}

function sanitizeFindings(findings: Finding[]): Finding[] {
  return findings.map((finding) => ({
    title: clipText(finding.title, 1, 240),
    severity: finding.severity,
    file: clipText(finding.file, 1, 500),
    line: finding.line,
    explanation: clipText(finding.explanation, 3, 500),
    suggestion: clipText(finding.suggestion, 3, 500),
    ...(finding.failureAfterChange === undefined ? {} : { failureAfterChange: clipText(finding.failureAfterChange, 3, 500) }),
    ...(finding.alreadyFixedByChange === undefined ? {} : { alreadyFixedByChange: finding.alreadyFixedByChange }),
  }));
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await mkdir(resolve(filePath, ".."), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function requireManifest(value: unknown): Manifest {
  if (!value || typeof value !== "object") throw new Error("evaluation/manifest.json is invalid.");
  const manifest = value as Manifest;
  if (manifest.schemaVersion !== 1 || manifest.cases.length !== manifest.selection.selectedCases) {
    throw new Error("The benchmark manifest is incomplete or has an unsupported schema.");
  }
  if (manifest.cases.length !== 30) throw new Error(`Expected the preregistered 30-case cohort, found ${manifest.cases.length}.`);
  return manifest;
}

function getRawFindingsSafe(findings: Finding[]) {
  return sanitizeFindings(findings);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const manifest = requireManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const manifestSha256 = sha256(await readFile(manifestPath));
  const reviewModel = process.env.OPENAI_REVIEW_MODEL ?? "gpt-4.1-mini";
  const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
  const dateDirectory = join(runsRoot, runDate);
  const runDirectory = runVariant === "baseline" ? dateDirectory : join(dateDirectory, runVariant);
  const resultsPath = join(root, "evaluation", runVariant === "baseline" ? "results.json" : forward ? `falsealarms-${runVariant}.json` : `results-${runVariant}.json`);
  if (runVariant === "baseline") throw new Error("The baseline benchmark is complete; run post-baseline work under a named DIFFSENSE_BENCHMARK_VARIANT.");
  if ((manifestFile === "manifest-holdout.json") !== runVariant.startsWith("holdout-")) throw new Error("HOLDOUT variants must be named holdout-* and use manifest-holdout.json, and only they may.");
  if ((manifestFile === "manifest-test.json") !== runVariant.startsWith("test-")) throw new Error("TEST variants must be named test-* and use manifest-test.json, and only they may.");
  const existingResults = await readJsonIfExists(resultsPath);
  if (existingResults) throw new Error("evaluation/results.json already exists; refusing to overwrite a completed benchmark.");

  for (const item of manifest.cases) {
    if (!(await readJsonIfExists<StoredCase>(join(runDirectory, `${caseId(item)}.json`))) && !(await readFile(diffPath(item), "utf8")).trim()) {
      throw new Error(`Missing cached diff for ${caseId(item)}. Run npm run build-dataset before benchmarking.`);
    }
  }

  const diffContents = new Map<string, string>();
  let knownDiffChars = 0;
  for (const item of manifest.cases) {
    const value = await readFile(diffPath(item), "utf8");
    diffContents.set(caseId(item), value);
    knownDiffChars += value.length;
  }

  const reviewAndContextCalls = manifest.cases.length * (withContextRuns + 1 + Number(includeNoContext));
  const minimumIndexEmbeddingCalls = manifest.cases.length;
  console.log(JSON.stringify({
    phase: dryRun ? "benchmark dry-run preflight" : "benchmark preflight",
    date: runDate,
    variant: runVariant,
    pipelineConfig,
    cases: manifest.cases.length,
    reviewAndContextCalls,
    includesNoContext: includeNoContext,
    minimumIndexEmbeddingCalls,
    minimumOpenAICalls: reviewAndContextCalls + minimumIndexEmbeddingCalls,
    sessionCaps: "1,000 calls / 10M tokens (evaluation/ledger/session-2.json)",
    approximateDiffTokens: Math.ceil(knownDiffChars / 3),
    tokenEstimates: "Diff-only approximation; index and retrieved-context batches will be estimated before each actual OpenAI request batch.",
    model: process.env.OPENAI_REVIEW_MODEL ?? "gpt-4.1-mini",
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
  }, null, 2));
  if (dryRun) return;

  const missingConfiguration = [
    !process.env.OPENAI_API_KEY && "OPENAI_API_KEY",
    !process.env.DATABASE_URL && "DATABASE_URL",
  ].filter(Boolean);
  if (missingConfiguration.length) {
    throw new Error(`Configure ${missingConfiguration.join(" and ")} before benchmarking.`);
  }

  // Post-baseline variants draw on the session ledger (evaluation/ledger/session-2.json), not the closed 2026-10-05 ledger.
  const budget = await createSessionBudget(`benchmark/${runVariant}`);
  const ledger = budget.ledger;
  console.log(`Resuming ${runVariant} with ${ledger.reservedCalls} session calls already reserved.`);

  const contextModule = await import("../src/lib/server/context");
  const pipelineModule = await import("../src/lib/server/review-pipeline");
  const reviewModule = await import("../src/lib/server/review");
  const databaseModule = await import("../src/lib/server/database");
  const evaluationModule = await import("../src/lib/evaluation");
  const pool = databaseModule.getPool();
  await pool.query("SELECT 1");

  const promptHash = reviewModule.getReviewPromptHash(pipelineConfig.promptRevision);
  console.log(`Benchmark model: ${reviewModel}; prompt revision ${pipelineConfig.promptRevision}, fingerprint ${promptHash}; config ${JSON.stringify(pipelineConfig)}.`);
  console.log(`Cohort: ${manifest.cases.length} cases; index cap: ${process.env.MAX_INDEX_FILES ?? "40"}; no-context ablation ${includeNoContext ? "enabled" : "omitted for this variant"}.`);

  for (const item of manifest.cases) {
    const id = caseId(item);
    const caseFile = join(runDirectory, `${id}.json`);
    const diff = diffContents.get(id);
    if (!diff) throw new Error(`No diff loaded for ${id}.`);
    const diffSha256 = sha256(diff);
    const existing = await readJsonIfExists<StoredCase>(caseFile);
    if (existing) {
      const matches = existing.manifestSha256 === manifestSha256
        && existing.diffSha256 === diffSha256
        && existing.fixedSha === item.fixSha
        && existing.buggySha === item.buggySha
        && existing.model === reviewModel
        && existing.embeddingModel === embeddingModel
        && existing.promptHash === promptHash
        && JSON.stringify(existing.pipelineConfig) === JSON.stringify(pipelineConfig);
      if (!matches) throw new Error(`Refusing to resume ${id}: manifest, diff, model, embedding model, prompt fingerprint, or pipeline config changed.`);
      if (existing.complete) {
        console.log(`RESUME ${id}: already complete; skipping.`);
        continue;
      }
    }

    // The index and changed-file text always come from the pre-change side: the fix commit for reversed diffs, its parent for forward diffs.
    const baseCommit = forward ? item.buggySha : item.fixSha;
    console.log(`CASE ${id}: index pre-change commit ${baseCommit}${forward ? " (forward fix diff)" : "; reverse-diff labels remain untouched"}.`);
    const addedLines = reviewModule.getAddedLines(diff);
    if (addedLines.length === 0 && !forward) throw new Error(`No added lines in the committed defect label diff for ${id}.`);
    const [owner, repositoryName] = item.upstreamRepository.split("/").slice(-2);
    const index = await contextModule.indexRepository(owner, repositoryName, baseCommit, budget);
    if (index.commitSha !== baseCommit) throw new Error(`Indexed ${index.commitSha} instead of pre-change commit ${baseCommit} for ${id}.`);

    const stored: StoredCase = existing ?? {
      schemaVersion: 1,
      runDate,
      caseId: id,
      project: item.project,
      bugId: item.bugId,
      upstreamRepository: item.upstreamRepository,
      fixedSha: item.fixSha,
      buggySha: item.buggySha,
      manifestSha256,
      diffSha256,
      pipelineConfig,
      model: reviewModel,
      embeddingModel,
      promptHash,
      index: {
        repository: index.repository,
        commitSha: index.commitSha,
        maxFiles: index.maxFiles,
        filesIndexed: index.filesIndexed,
        chunksIndexed: index.chunksIndexed,
        embeddingUsage: index.embeddingUsage,
      },
      context: { chunkRefs: [], embeddingUsage: zeroUsage() },
      arms: { withContext: [], withoutContext: null },
      complete: false,
    };
    stored.index = {
      repository: index.repository,
      commitSha: index.commitSha,
      maxFiles: index.maxFiles,
      filesIndexed: index.filesIndexed,
      chunksIndexed: index.chunksIndexed,
      embeddingUsage: addUsage(stored.index.embeddingUsage, index.embeddingUsage),
    };
    await writeJsonAtomic(caseFile, stored);

    // Same context builder as /api/review (src/lib/server/review-pipeline.ts).
    const retrieved = await pipelineModule.buildReviewContext({
      owner,
      repository: repositoryName,
      repositoryKey: index.repository,
      baseCommit,
      diff,
      config: {
        promptRevision: pipelineConfig.promptRevision,
        includeChangedFiles: pipelineConfig.includeChangedFiles,
        changedFilesExcludeTests: pipelineConfig.changedFilesExcludeTests === true,
        changedFileSide: pipelineConfig.changedFileSide ?? "before",
        retrievalK: pipelineConfig.retrievalK,
        acceptance: pipelineConfig.acceptance ?? "exact",
      },
      budget,
    });
    if (retrieved.chunks.length === 0) throw new Error(`No context retrieved for ${id}; refusing to label a context arm as complete.`);
    const changedFiles = retrieved.changedFiles;
    const reviewContext = retrieved.context;
    stored.context = {
      changedFileRefs: changedFiles.map((file) => ({ path: file.path, contentSha256: sha256(file.content) })),
      chunkRefs: retrieved.chunks.map((chunk: { path: string; content: string }) => ({ path: chunk.path, contentSha256: sha256(chunk.content) })),
      embeddingUsage: addUsage(stored.context.embeddingUsage, retrieved.embeddingUsage),
    };
    await writeJsonAtomic(caseFile, stored);

    while (stored.arms.withContext.length < withContextRuns) {
      const runNumber = stored.arms.withContext.length + 1;
      if (addedLines.length === 0) {
        // A fix that only deletes lines leaves nothing a finding could be accepted on; no review call is made.
        stored.arms.withContext.push({ model: reviewModel, promptHash, usage: zeroUsage(), rawFindings: [], acceptedFindings: [], skipped: "no added lines" } as StoredReview);
        await writeJsonAtomic(caseFile, stored);
        console.log(`RESULT ${id} run ${runNumber}: skipped (diff adds no lines).`);
        continue;
      }
      const review = await reviewModule.reviewDiffDetailed(diff, addedLines, reviewContext, budget, pipelineConfig.promptRevision, pipelineConfig.acceptance ?? "exact");
      if (review.model !== reviewModel || review.promptHash !== stored.promptHash) throw new Error(`Model or prompt fingerprint changed during ${id}.`);
      stored.arms.withContext.push({
        model: review.model,
        promptHash: review.promptHash,
        usage: review.usage,
        rawFindings: getRawFindingsSafe(review.rawFindings),
        acceptedFindings: sanitizeFindings(review.findings),
      });
      await writeJsonAtomic(caseFile, stored);
      console.log(`RESULT ${id} with-context run ${runNumber}/${withContextRuns}: ${review.findings.length} accepted finding(s), ${review.usage.totalTokens} tokens.`);
    }

    if (includeNoContext && !stored.arms.withoutContext) {
      const review = await reviewModule.reviewDiffDetailed(diff, addedLines, [], budget, pipelineConfig.promptRevision);
      if (review.model !== reviewModel || review.promptHash !== stored.promptHash) throw new Error(`Model or prompt fingerprint changed during ${id}.`);
      stored.arms.withoutContext = {
        model: review.model,
        promptHash: review.promptHash,
        usage: review.usage,
        rawFindings: getRawFindingsSafe(review.rawFindings),
        acceptedFindings: sanitizeFindings(review.findings),
      };
      await writeJsonAtomic(caseFile, stored);
      console.log(`RESULT ${id} no-context: ${review.findings.length} accepted finding(s), ${review.usage.totalTokens} tokens.`);
    }

    stored.complete = true;
    await writeJsonAtomic(caseFile, stored);
  }

  const caseResults: StoredCase[] = [];
  for (const item of manifest.cases) {
    const record = await readJsonIfExists<StoredCase>(join(runDirectory, `${caseId(item)}.json`));
    if (!record?.complete || record.arms.withContext.length !== withContextRuns || (includeNoContext && !record.arms.withoutContext)) {
      throw new Error(`Benchmark is incomplete at ${caseId(item)}; raw runs remain resumable and results.json was not written.`);
    }
    caseResults.push(record);
  }

  if (forward) {
    // Forward fix diffs have no defect labels: every accepted finding is a potential false alarm (evaluation/ROUND2.md, R2).
    const testPath = /(?:^|\/)(?:test|tests|__tests__|spec|specs)\/|\.(?:test|spec)\.[^/]+$/i;
    const cases = caseResults.map((record) => {
      const findings = record.arms.withContext[0].acceptedFindings.map((finding) => ({ ...finding, isTest: testPath.test(finding.file) }));
      return { caseId: record.caseId, skipped: (record.arms.withContext[0] as StoredReview & { skipped?: string }).skipped ?? null, findings };
    });
    const flagged = cases.filter((item) => item.findings.length > 0);
    const allFindings = cases.flatMap((item) => item.findings);
    const output = {
      schemaVersion: 1,
      kind: "forward-fix-false-alarms",
      benchmarkDate: runDate,
      benchmarkVariant: runVariant,
      pipelineConfig,
      manifestSha256,
      models: { review: reviewModel, embedding: embeddingModel },
      reviewPromptSha256: promptHash,
      summary: {
        cases: cases.length,
        casesReviewed: cases.filter((item) => !item.skipped).length,
        casesFlagged: flagged.length,
        casesFlaggedOnSource: cases.filter((item) => item.findings.some((finding) => !finding.isTest)).length,
        findings: allFindings.length,
        sourceFindings: allFindings.filter((finding) => !finding.isTest).length,
        testFindings: allFindings.filter((finding) => finding.isTest).length,
      },
      cases,
    };
    await writeJsonAtomic(resultsPath, output);
    console.log(`RESULTS ${resultsPath}`);
    console.log(JSON.stringify(output.summary, null, 2));
    return;
  }

  function makeEvaluationInput(findingsForCase: (record: StoredCase) => Finding[]) {
    return {
      pullRequests: caseResults.map((record) => {
        const manifestCase = manifest.cases.find((item) => caseId(item) === record.caseId);
        if (!manifestCase) throw new Error(`Unknown case ${record.caseId} in the manifest.`);
        return {
          id: record.caseId,
          knownDefects: manifestCase.defectLineRanges,
          assistedFindings: findingsForCase(record).map(({ file, line }) => ({ file, line })),
        };
      }),
      regressionScenarios: [],
    };
  }

  const withContext = Array.from({ length: withContextRuns }, (_, runIndex) => {
    const runNumber = runIndex + 1;
    const input = makeEvaluationInput((record) => record.arms.withContext[runIndex].acceptedFindings);
    return { runNumber, pullRequests: input.pullRequests, metrics: evaluationModule.evaluate(input) };
  });
  const withoutContext = includeNoContext
    ? (() => {
      const input = makeEvaluationInput((record) => record.arms.withoutContext?.acceptedFindings ?? []);
      return [{ runNumber: 1, pullRequests: input.pullRequests, metrics: evaluationModule.evaluate(input) }];
    })()
    : [];
  const result = {
    schemaVersion: 1,
    benchmarkDate: runDate,
    benchmarkVariant: runVariant,
    pipelineConfig,
    dataset: manifest.dataset,
    selection: manifest.selection,
    manifestSha256,
    models: { review: reviewModel, embedding: embeddingModel },
    reviewPromptSha256: promptHash,
    manualReview: { status: "unmeasured", reason: "The paired human timing study has not been run." },
    regressionEvaluation: { status: "not_run", reason: "Seeded regression scenarios have not been authored or executed." },
    arms: { withContext, withoutContext },
    usage: ledger,
  };
  await writeJsonAtomic(resultsPath, result);
  console.log(`RESULTS ${resultsPath}`);
  console.log(JSON.stringify({
    withContext: withContext.map((run) => ({ run: run.runNumber, precision: run.metrics.precision, recall: run.metrics.recall })),
    withoutContext: withoutContext.map((run) => ({ run: run.runNumber, precision: run.metrics.precision, recall: run.metrics.recall })),
    callsReserved: ledger.reservedCalls,
    actualCallsCompleted: ledger.completedCalls,
    estimatedInputTokens: ledger.estimatedInputTokens,
    observedTokens: ledger.observedTotalTokens,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Benchmark failed.");
  process.exitCode = 1;
});
