import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const root = process.cwd();
const manifestPath = join(root, "evaluation", "manifest.json");
const resultsPath = join(root, "evaluation", "results.json");
const cacheRoot = resolve(process.env.DIFFSENSE_BENCHMARK_CACHE ?? join(tmpdir(), "diffsense-benchmark-cache"));
const diffRoot = join(cacheRoot, "diffs");
const runsRoot = join(root, "evaluation", "runs");
const runDate = process.env.DIFFSENSE_RUN_DATE ?? new Date().toISOString().slice(0, 10);
const callLimit = 500;
const withContextRuns = 3;

if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate) || Number.isNaN(Date.parse(`${runDate}T00:00:00Z`))) {
  throw new Error("DIFFSENSE_RUN_DATE must use YYYY-MM-DD.");
}

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
    chunkRefs: { path: string; contentSha256: string }[];
    embeddingUsage: TokenUsage;
  };
  arms: {
    withContext: StoredReview[];
    withoutContext: StoredReview | null;
  };
  complete: boolean;
};

type BudgetLedger = {
  runDate: string;
  callLimit: number;
  reservedCalls: number;
  completedCalls: number;
  estimatedInputTokens: number;
  observedInputTokens: number;
  observedOutputTokens: number;
  observedTotalTokens: number;
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
  return join(diffRoot, `${slug}-${item.bugId}.diff`);
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
  const runDirectory = join(runsRoot, runDate);
  const budgetPath = join(runDirectory, "budget.json");
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

  const reviewAndContextCalls = manifest.cases.length * (withContextRuns + 2);
  const minimumIndexEmbeddingCalls = manifest.cases.length;
  console.log(JSON.stringify({
    phase: dryRun ? "benchmark dry-run preflight" : "benchmark preflight",
    date: runDate,
    cases: manifest.cases.length,
    reviewAndContextCalls,
    minimumIndexEmbeddingCalls,
    minimumOpenAICalls: reviewAndContextCalls + minimumIndexEmbeddingCalls,
    maximumOpenAICalls: callLimit,
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

  const priorBudget = await readJsonIfExists<BudgetLedger>(budgetPath);
  const ledger: BudgetLedger = priorBudget ?? {
    runDate,
    callLimit,
    reservedCalls: 0,
    completedCalls: 0,
    estimatedInputTokens: 0,
    observedInputTokens: 0,
    observedOutputTokens: 0,
    observedTotalTokens: 0,
  };
  if (ledger.runDate !== runDate || ledger.callLimit !== callLimit) throw new Error("Existing budget ledger does not match this run configuration.");

  console.log(`Resuming with ${ledger.reservedCalls}/${callLimit} OpenAI calls already reserved.`);

  const contextModule = await import("../src/lib/server/context");
  const reviewModule = await import("../src/lib/server/review");
  const databaseModule = await import("../src/lib/server/database");
  const evaluationModule = await import("../src/lib/evaluation");
  const pool = databaseModule.getPool();
  await pool.query("SELECT 1");

  const budget = {
    async beforeBatch(label: string, apiCalls: number, estimatedTokens: number) {
      if (!Number.isSafeInteger(apiCalls) || apiCalls < 1 || !Number.isSafeInteger(estimatedTokens) || estimatedTokens < 0) {
        throw new Error(`Invalid API budget estimate for ${label}.`);
      }
      const reservedCalls = ledger.reservedCalls + apiCalls;
      const cumulativeTokens = ledger.estimatedInputTokens + estimatedTokens;
      console.log(`BUDGET ${label}: next batch ${apiCalls} API call(s), approximately ${estimatedTokens} input tokens; cumulative ${reservedCalls}/${callLimit} calls, approximately ${cumulativeTokens} input tokens.`);
      if (reservedCalls > callLimit) throw new Error(`OpenAI call budget exceeded (${reservedCalls} > ${callLimit}); aborting before this batch.`);
      ledger.reservedCalls = reservedCalls;
      ledger.estimatedInputTokens = cumulativeTokens;
      await writeJsonAtomic(budgetPath, ledger);
    },
    async recordUsage(_label: string, usage: TokenUsage) {
      ledger.completedCalls += 1;
      ledger.observedInputTokens += usage.inputTokens;
      ledger.observedOutputTokens += usage.outputTokens;
      ledger.observedTotalTokens += usage.totalTokens;
      await writeJsonAtomic(budgetPath, ledger);
    },
  };

  console.log(`Benchmark model: ${reviewModel}; prompt fingerprint: ${reviewModule.reviewPromptHash}.`);
  console.log(`Cohort: ${manifest.cases.length} cases; index cap: ${process.env.MAX_INDEX_FILES ?? "40"}; no-context ablation enabled.`);

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
        && existing.promptHash === reviewModule.reviewPromptHash;
      if (!matches) throw new Error(`Refusing to resume ${id}: manifest, diff, model, embedding model, or prompt fingerprint changed.`);
      if (existing.complete) {
        console.log(`RESUME ${id}: already complete; skipping.`);
        continue;
      }
    }

    console.log(`CASE ${id}: index fixed commit ${item.fixSha}; reverse-diff labels remain untouched.`);
    const addedLines = reviewModule.getAddedLines(diff);
    if (addedLines.length === 0) throw new Error(`No added lines in the committed defect label diff for ${id}.`);
    const index = await contextModule.indexRepository(
      item.upstreamRepository.split("/").slice(-2)[0],
      item.upstreamRepository.split("/").slice(-1)[0],
      item.fixSha,
      budget,
    );
    if (index.commitSha !== item.fixSha) throw new Error(`Indexed ${index.commitSha} instead of fixed commit ${item.fixSha} for ${id}.`);

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
      model: reviewModel,
      embeddingModel,
      promptHash: reviewModule.reviewPromptHash,
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

    const retrieved = await contextModule.retrieveRepositoryContextDetailed(index.repository, diff, budget);
    if (retrieved.chunks.length === 0) throw new Error(`No context retrieved for ${id}; refusing to label a context arm as complete.`);
    stored.context = {
      chunkRefs: retrieved.chunks.map((chunk: { path: string; content: string }) => ({ path: chunk.path, contentSha256: sha256(chunk.content) })),
      embeddingUsage: addUsage(stored.context.embeddingUsage, retrieved.embeddingUsage),
    };
    await writeJsonAtomic(caseFile, stored);

    while (stored.arms.withContext.length < withContextRuns) {
      const runNumber = stored.arms.withContext.length + 1;
      const review = await reviewModule.reviewDiffDetailed(diff, addedLines, retrieved.chunks, budget);
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

    if (!stored.arms.withoutContext) {
      const review = await reviewModule.reviewDiffDetailed(diff, addedLines, [], budget);
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
    if (!record?.complete || record.arms.withContext.length !== withContextRuns || !record.arms.withoutContext) {
      throw new Error(`Benchmark is incomplete at ${caseId(item)}; raw runs remain resumable and results.json was not written.`);
    }
    caseResults.push(record);
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
  const withoutContextInput = makeEvaluationInput((record) => record.arms.withoutContext?.acceptedFindings ?? []);
  const withoutContext = [{ runNumber: 1, pullRequests: withoutContextInput.pullRequests, metrics: evaluationModule.evaluate(withoutContextInput) }];
  const result = {
    schemaVersion: 1,
    benchmarkDate: runDate,
    dataset: manifest.dataset,
    selection: manifest.selection,
    manifestSha256,
    models: { review: reviewModel, embedding: embeddingModel },
    reviewPromptSha256: reviewModule.reviewPromptHash,
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
