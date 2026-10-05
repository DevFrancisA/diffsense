import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Helpers shared by the regression harnesses. scripts/regressions.ts keeps its own copies unchanged because it is the
// executed Round-1 harness; this module is a verbatim extraction used by scripts/regressions-v2.ts.
export const root = process.cwd();
export const workRoot = resolve(process.env.DIFFSENSE_REGRESSION_WORKDIR ?? join(tmpdir(), "diffsense-regressions"));
const isWindows = process.platform === "win32";

export type RunOutcome = "pass" | "assertion" | "action" | "infra";
export type TestRecord = { title: string; status: string; failedStep: string | null; error: string | null; outcome: RunOutcome };
export type PlanRun = { outcome: RunOutcome; tests: TestRecord[] };

export const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();

export function writeJson(filePath: string, value: unknown) {
  mkdirSync(resolve(filePath, ".."), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, filePath);
}

export function readJson<T>(filePath: string): T | null {
  return existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) as T : null;
}

// The app under test must run credential-free: strip every secret the harness itself loaded from .env files.
export function credentialFreeEnv(port?: number) {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(OPENAI_|DATABASE_URL$|GITHUB_TOKEN$|NODE_ENV$|PORT$)|KEY|TOKEN|SECRET|PASSWORD/i.test(key)) continue;
    env[key] = value;
  }
  return (port === undefined ? env : { ...env, NODE_ENV: "production", PORT: String(port) }) as NodeJS.ProcessEnv;
}

export function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = credentialFreeEnv()) {
  // Only npm (a .cmd shim on Windows) needs a shell; everything else is spawned directly, since paths contain spaces.
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", shell: isWindows && command === "npm", maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

export function prepareWorktree(name: string, base: string) {
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

const nextBin = (directory: string) => join(directory, "node_modules", "next", "dist", "bin", "next");

export function build(directory: string) {
  return run(process.execPath, [nextBin(directory), "build"], directory);
}

export async function waitForServer(port: number, timeoutMs = 60_000) {
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

export function startServer(directory: string, port: number) {
  return spawn(process.execPath, [nextBin(directory), "start", "-p", String(port)], { cwd: directory, env: credentialFreeEnv(port), stdio: "ignore" });
}

export function stopServer(server: ChildProcess | null) {
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

export function runPlan(planPath: string, port: number): PlanRun {
  const env = { ...credentialFreeEnv(), CI: "1", PLAYWRIGHT_BASE_URL: `http://127.0.0.1:${port}`, DIFFSENSE_TEST_PLAN: planPath } as NodeJS.ProcessEnv;
  const playwrightCli = join(root, "node_modules", "@playwright", "test", "cli.js");
  const result = spawnSync(process.execPath, [playwrightCli, "test", "tests/generated-plan.spec.ts", "--retries=0", "--workers=1", "--reporter=json"], {
    cwd: root, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
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

export function isApiError(error: unknown) {
  const name = error && typeof error === "object" && "constructor" in error ? (error as { constructor: { name: string } }).constructor.name : "";
  return /APIError|APIConnection|RateLimit|InternalServer|Authentication|PermissionDenied/.test(name);
}
