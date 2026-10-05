import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadEnvConfig } from "@next/env";
import { createSessionBudget } from "./session-budget";

loadEnvConfig(process.cwd());

// Regression-detection harness. Definitions live in evaluation/regressions/PROTOCOL.md and must not change after a run starts.
const root = process.cwd();
const regressionsRoot = join(root, "evaluation", "regressions");
const runsRoot = join(regressionsRoot, "runs");
const plansRoot = join(regressionsRoot, "plans");
const workRoot = resolve(process.env.DIFFSENSE_REGRESSION_WORKDIR ?? join(tmpdir(), "diffsense-regressions"));
const baselinePort = 3101;
const patchedPort = 3102;
const owner = "DevFrancisA";
const repositoryName = "diffsense";
const repository = `${owner}/${repositoryName}`.toLowerCase();
const requiredValid = 40;
const isWindows = process.platform === "win32";

type Scenario = { id: string; role: "primary" | "reserve"; file: string; intendedBreak: string };
type RunOutcome = "pass" | "assertion" | "action" | "infra";
type TestRecord = { title: string; status: string; failedStep: string | null; error: string | null; outcome: RunOutcome };
type PlanRun = { outcome: RunOutcome; tests: TestRecord[] };
type ScenarioStatus = "detected" | "not-detected" | "invalid-plan" | "infra-invalid";
type ScenarioRecord = {
  id: string;
  role: string;
  intendedBreak: string;
  status: ScenarioStatus;
  reason: string;
  plan: { scenarios: number; steps: number; usage?: { inputTokens: number; outputTokens: number; totalTokens: number }; contextChunks?: string[] } | null;
  baselineRuns: PlanRun[];
  patchedRun: PlanRun | null;
  completedAt: string;
};

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();

function writeJson(filePath: string, value: unknown) {
  mkdirSync(resolve(filePath, ".."), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, filePath);
}

function readJson<T>(filePath: string): T | null {
  return existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) as T : null;
}

// The app under test must run credential-free: strip every secret the harness itself loaded from .env files.
function credentialFreeEnv(port?: number) {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(OPENAI_|DATABASE_URL$|GITHUB_TOKEN$|NODE_ENV$|PORT$)|KEY|TOKEN|SECRET|PASSWORD/i.test(key)) continue;
    env[key] = value;
  }
  return (port === undefined ? env : { ...env, NODE_ENV: "production", PORT: String(port) }) as NodeJS.ProcessEnv;
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = credentialFreeEnv()) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", shell: isWindows, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function prepareWorktree(name: string, base: string) {
  const directory = join(workRoot, name);
  if (!existsSync(join(directory, ".git"))) {
    mkdirSync(workRoot, { recursive: true });
    git(root, "worktree", "add", "--detach", directory, base);
  }
  git(directory, "reset", "--hard", base);
  git(directory, "clean", "-fdx", "-e", "node_modules");
  if (!existsSync(join(directory, "node_modules"))) {
    const install = run("npm", ["ci", "--no-audit", "--no-fund"], directory);
    if (!install.ok) throw new Error(`npm ci failed in ${name}:\n${install.output.slice(-2000)}`);
  }
  return directory;
}

function build(directory: string) {
  return run("npx", ["next", "build"], directory);
}

async function waitForServer(port: number, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { cache: "no-store" });
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  return false;
}

function startServer(directory: string, port: number) {
  return spawn("npx", ["next", "start", "-p", String(port)], { cwd: directory, env: credentialFreeEnv(port), shell: isWindows, stdio: "ignore" });
}

function stopServer(server: ChildProcess | null) {
  if (!server?.pid) return;
  if (isWindows) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  else server.kill("SIGTERM");
}

type JsonStep = { title: string; error?: { message?: string }; steps?: JsonStep[] };
type JsonResult = { status: string; error?: { message?: string }; errors?: { message?: string }[]; steps?: JsonStep[] };
type JsonSuite = { suites?: JsonSuite[]; specs?: { title: string; tests: { results: JsonResult[] }[] }[] };

function findFailedPlanStep(steps: JsonStep[] = []): JsonStep | null {
  for (const step of steps) {
    if (step.title.startsWith("plan step ") && step.error) return step;
    const nested = findFailedPlanStep(step.steps);
    if (nested) return nested;
  }
  return null;
}

const infraPattern = /net::ERR_|ECONNREFUSED|ECONNRESET|Target page, context or browser has been closed|browserType\.launch/i;

function classifyTest(result: JsonResult): Omit<TestRecord, "title"> {
  if (result.status === "passed") return { status: result.status, failedStep: null, error: null, outcome: "pass" };
  const step = findFailedPlanStep(result.steps);
  const message = (step?.error?.message ?? result.error?.message ?? result.errors?.map((error) => error.message).join("\n") ?? "").replace(/\u001b\[[0-9;]*m/g, "");
  const action = step?.title.replace(/^plan step \d+: /, "") ?? null;
  let outcome: RunOutcome;
  if (!step || action === "goto" || infraPattern.test(message)) outcome = "infra";
  else if (action?.startsWith("expect")) outcome = "assertion";
  else outcome = "action";
  return { status: result.status, failedStep: step?.title ?? null, error: message.slice(0, 600), outcome };
}

function runPlan(planPath: string, port: number): PlanRun {
  const env = { ...credentialFreeEnv(), CI: "1", PLAYWRIGHT_BASE_URL: `http://127.0.0.1:${port}`, DIFFSENSE_TEST_PLAN: planPath } as NodeJS.ProcessEnv;
  const result = spawnSync("npx", ["playwright", "test", "tests/generated-plan.spec.ts", "--retries=0", "--workers=1", "--reporter=json"], {
    cwd: root, env, encoding: "utf8", shell: isWindows, maxBuffer: 64 * 1024 * 1024,
  });
  let report: { suites: JsonSuite[] };
  try {
    report = JSON.parse(String(result.stdout));
  } catch {
    return { outcome: "infra", tests: [{ title: "(runner)", status: "error", failedStep: null, error: `${result.stdout}${result.stderr}`.slice(-600), outcome: "infra" }] };
  }
  const tests: TestRecord[] = [];
  const visit = (suite: JsonSuite) => {
    suite.suites?.forEach(visit);
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) tests.push({ title: spec.title, ...classifyTest(test.results[test.results.length - 1]) });
    }
  };
  report.suites.forEach(visit);
  if (tests.length === 0) return { outcome: "infra", tests: [{ title: "(runner)", status: "no-tests", failedStep: null, error: String(result.stderr).slice(-600), outcome: "infra" }] };
  const outcomes = new Set(tests.map((test) => test.outcome));
  const outcome: RunOutcome = outcomes.has("infra") ? "infra" : outcomes.has("assertion") ? "assertion" : outcomes.has("action") ? "action" : "pass";
  return { outcome, tests };
}

function isApiError(error: unknown) {
  const name = error && typeof error === "object" && "constructor" in error ? (error as { constructor: { name: string } }).constructor.name : "";
  return /APIError|APIConnection|RateLimit|InternalServer|Authentication|PermissionDenied/.test(name);
}

async function main() {
  const base = process.env.DIFFSENSE_REGRESSION_BASE;
  if (!base || !/^[0-9a-f]{40}$/.test(base)) throw new Error("Set DIFFSENSE_REGRESSION_BASE to the full SHA of a pushed commit.");
  const dryRun = process.argv.includes("--dry-run");

  // Only content tracked at a commit already on GitHub is indexed (the indexer reads the GitHub tree at that SHA).
  git(root, "fetch", "origin", "main");
  if (!git(root, "branch", "-r", "--contains", base).split("\n").some((branch) => branch.trim() === "origin/main")) {
    throw new Error(`${base} is not on origin/main; push it before indexing.`);
  }
  const tracked = git(root, "ls-tree", "-r", "--name-only", base).split("\n");
  if (tracked.some((path) => /(^|\/)\.env(?!\.example$)/.test(path))) throw new Error("A .env file is tracked at the base commit; refusing to index.");

  const definition = JSON.parse(readFileSync(join(regressionsRoot, "scenarios.json"), "utf8")) as { scenarios: Scenario[] };
  const scenarios = definition.scenarios;
  console.log(JSON.stringify({
    phase: dryRun ? "regression dry-run preflight" : "regression preflight",
    base,
    scenarios: scenarios.length,
    estimatedCalls: { index: "1-2 embedding batches (skipped if already indexed at base)", perScenario: 2, maximum: 2 + scenarios.length * 2 },
    trackedIndexableFiles: tracked.filter((path) => /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|mjs|php|py|rb|rs|sql|svelte|ts|tsx|vue)$/i.test(path)).length,
  }, null, 2));
  if (dryRun) return;

  const budget = await createSessionBudget("regressions");
  const contextModule = await import("../src/lib/server/context");
  const planModule = await import("../src/lib/server/test-plan");
  const { getPool } = await import("../src/lib/server/database");

  const indexRecordPath = join(regressionsRoot, "index.json");
  const indexed = await getPool().query<{ count: string }>("SELECT count(*) FROM repository_chunks WHERE repository = $1 AND commit_sha = $2", [repository, base]).catch(() => ({ rows: [{ count: "0" }] }));
  if (Number(indexed.rows[0].count) === 0) {
    const result = await contextModule.indexRepository(owner, repositoryName, base, budget);
    if (result.commitSha !== base) throw new Error(`Indexed ${result.commitSha}, expected ${base}.`);
    writeJson(indexRecordPath, { ...result, indexedAt: new Date().toISOString() });
    console.log(`Indexed ${result.filesIndexed} files / ${result.chunksIndexed} chunks at ${base}.`);
  }

  const baselineDirectory = prepareWorktree("baseline", base);
  const baselineBuild = build(baselineDirectory);
  if (!baselineBuild.ok) throw new Error(`Baseline build failed:\n${baselineBuild.output.slice(-3000)}`);
  let baselineServer: ChildProcess | null = startServer(baselineDirectory, baselinePort);
  if (!await waitForServer(baselinePort)) throw new Error("Baseline server did not start.");
  const patchedDirectory = prepareWorktree("patched", base);

  try {
    let valid = 0;
    for (const scenario of scenarios) {
      // Reserves are reached only after primaries were lost to infrastructure failures.
      if (valid >= requiredValid) break;
      const recordPath = join(runsRoot, `${scenario.id}.json`);
      const existing = readJson<ScenarioRecord>(recordPath);
      if (existing) {
        if (existing.status !== "infra-invalid") valid += 1;
        console.log(`SKIP ${scenario.id}: already ${existing.status}.`);
        continue;
      }
      const finish = (record: Omit<ScenarioRecord, "id" | "role" | "intendedBreak" | "completedAt">) => {
        const full: ScenarioRecord = { id: scenario.id, role: scenario.role, intendedBreak: scenario.intendedBreak, ...record, completedAt: new Date().toISOString() };
        writeJson(recordPath, full);
        if (full.status !== "infra-invalid") valid += 1;
        console.log(`RESULT ${scenario.id}: ${full.status} (${full.reason}); valid so far ${valid}/${requiredValid}.`);
      };

      // 1. Apply and build the patched app before spending any API call.
      git(patchedDirectory, "reset", "--hard", base);
      git(patchedDirectory, "clean", "-fdx", "-e", "node_modules");
      const patchPath = join(regressionsRoot, `${scenario.id}.patch`);
      const apply = run("git", ["-c", "core.autocrlf=false", "apply", patchPath], patchedDirectory);
      if (!apply.ok) { finish({ status: "infra-invalid", reason: `patch did not apply: ${apply.output.slice(0, 300)}`, plan: null, baselineRuns: [], patchedRun: null }); continue; }
      const patchedBuild = build(patchedDirectory);
      if (!patchedBuild.ok) { finish({ status: "infra-invalid", reason: `patched build failed: ${patchedBuild.output.slice(-300)}`, plan: null, baselineRuns: [], patchedRun: null }); continue; }

      // 2. Generate a plan from the patch diff with the same logic as /api/tests/generate.
      const diff = readFileSync(patchPath, "utf8").trim();
      const planPath = join(plansRoot, `${scenario.id}.json`);
      let planInfo: ScenarioRecord["plan"];
      try {
        const context = await contextModule.retrieveRepositoryContextDetailed(repository, diff, budget);
        if (context.chunks.length === 0) throw new Error("No indexed context was retrieved.");
        const generated = await planModule.generateRegressionPlan(diff, context.chunks, budget);
        writeJson(planPath, generated.plan);
        planInfo = {
          scenarios: generated.plan.scenarios.length,
          steps: generated.plan.scenarios.reduce((total, item) => total + item.steps.length, 0),
          usage: { inputTokens: generated.usage.inputTokens + context.embeddingUsage.inputTokens, outputTokens: generated.usage.outputTokens, totalTokens: generated.usage.totalTokens + context.embeddingUsage.totalTokens },
          contextChunks: context.chunks.map((chunk) => chunk.path),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/cap would be exceeded/.test(message)) throw error;
        finish({ status: isApiError(error) ? "infra-invalid" : "invalid-plan", reason: `plan generation failed: ${message.slice(0, 300)}`, plan: null, baselineRuns: [], patchedRun: null });
        continue;
      }

      // 3. Baseline twice; the plan is valid only if both runs pass.
      if (!await waitForServer(baselinePort, 2_000)) {
        stopServer(baselineServer);
        baselineServer = startServer(baselineDirectory, baselinePort);
        if (!await waitForServer(baselinePort)) throw new Error("Baseline server stopped and could not restart.");
      }
      const baselineRuns = [runPlan(planPath, baselinePort), runPlan(planPath, baselinePort)];
      if (baselineRuns.some((item) => item.outcome === "infra")) { finish({ status: "infra-invalid", reason: "infrastructure failure on baseline", plan: planInfo, baselineRuns, patchedRun: null }); continue; }
      if (baselineRuns.some((item) => item.outcome !== "pass")) { finish({ status: "invalid-plan", reason: `baseline outcomes ${baselineRuns.map((item) => item.outcome).join("/")}`, plan: planInfo, baselineRuns, patchedRun: null }); continue; }

      // 4. Patched app once.
      const patchedServer = startServer(patchedDirectory, patchedPort);
      let patchedRun: PlanRun | null = null;
      try {
        if (!await waitForServer(patchedPort)) { finish({ status: "infra-invalid", reason: "patched server did not start", plan: planInfo, baselineRuns, patchedRun: null }); continue; }
        patchedRun = runPlan(planPath, patchedPort);
      } finally {
        stopServer(patchedServer);
        await new Promise((done) => setTimeout(done, 1_000));
      }
      if (patchedRun.outcome === "infra") finish({ status: "infra-invalid", reason: "infrastructure failure on patched app", plan: planInfo, baselineRuns, patchedRun });
      else if (patchedRun.outcome === "assertion") finish({ status: "detected", reason: "assertion step failed on patched app", plan: planInfo, baselineRuns, patchedRun });
      else finish({ status: "not-detected", reason: patchedRun.outcome === "pass" ? "plan passed on patched app" : "only non-assertion (click/fill) steps failed on patched app", plan: planInfo, baselineRuns, patchedRun });
    }
  } finally {
    stopServer(baselineServer);
  }

  summarize(scenarios, base);
}

function summarize(scenarios: Scenario[], base: string) {
  const records = scenarios.map((scenario) => readJson<ScenarioRecord>(join(runsRoot, `${scenario.id}.json`))).filter((record): record is ScenarioRecord => record !== null);
  const validRecords = records.filter((record) => record.status !== "infra-invalid");
  const count = (status: ScenarioStatus) => records.filter((record) => record.status === status).length;
  const detected = count("detected");
  const invalidPlans = count("invalid-plan");
  const validPlans = validRecords.length - invalidPlans;
  const ledger = readJson<{ completedCalls: number; observedTotalTokens: number }>(join(root, "evaluation", "ledger", "session-2.json"));
  writeJson(join(regressionsRoot, "results.json"), {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseSha: base,
    protocol: "evaluation/regressions/PROTOCOL.md",
    authoring: "Scenarios (patches) were authored with Claude Code assistance; detection is computed by executing generated plans.",
    model: process.env.OPENAI_REVIEW_MODEL ?? "gpt-4.1-mini",
    index: readJson(join(regressionsRoot, "index.json")),
    summary: {
      scenariosAttempted: records.length,
      validScenarios: validRecords.length,
      replacedForInfrastructure: count("infra-invalid"),
      detected,
      notDetected: count("not-detected"),
      invalidPlans,
      validPlans,
      detectedOverValidScenarios: validRecords.length ? detected / validRecords.length : null,
      detectedOverValidPlans: validPlans ? detected / validPlans : null,
    },
    sessionLedgerAtSummary: ledger,
    scenarios: records.map((record) => ({ id: record.id, role: record.role, status: record.status, reason: record.reason, intendedBreak: record.intendedBreak })),
  });
  console.log(`SUMMARY detected ${detected}/${validRecords.length} valid scenarios; ${detected}/${validPlans} valid plans; ${invalidPlans} invalid plans; ${count("infra-invalid")} infra-invalid.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
