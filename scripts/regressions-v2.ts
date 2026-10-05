import { type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvConfig } from "@next/env";
import { chromium } from "@playwright/test";
import {
  build, git, isApiError, prepareWorktree, type PlanRun, readJson, root, run, runPlan, startServer, stopServer, waitForServer, writeJson,
} from "./regression-lib";
import { createSessionBudget } from "./session-budget";

loadEnvConfig(process.cwd());

// Protocol v2 (evaluation/ROUND2.md, R5/R6): baseline quarantine per scenario, benign controls, generator v2.
// Usage: tsx scripts/regressions-v2.ts <dev|holdout|replay-v1>   (DIFFSENSE_REGRESSION_BASE = pushed base commit)
const set = process.argv[2];
if (set !== "dev" && set !== "holdout" && set !== "replay-v1") throw new Error("Usage: regressions-v2.ts <dev|holdout|replay-v1>");
const regressionsRoot = join(root, "evaluation", "regressions");
const v2Root = join(regressionsRoot, "v2");
const runsRoot = join(v2Root, `runs-${set}`);
const plansRoot = join(v2Root, `plans-${set}`);
const baselinePort = 3111;
const patchedPort = 3112;
const owner = "DevFrancisA";
const repositoryName = "diffsense";
const repository = `${owner}/${repositoryName}`.toLowerCase();

type Scenario = { id: string; role: string; intendedBreak: string; patchPath: string };
type Status = "detected" | "not-detected" | "false-alarm" | "no-alarm" | "invalid-plan" | "infra-invalid";
type Record = {
  id: string;
  role: string;
  intendedBreak: string;
  status: Status;
  reason: string;
  generation: { scenarios: number; dropped: { title: string; reason: string }[]; usage?: unknown } | null;
  baselineRuns: PlanRun[];
  surviving: string[];
  patchedRun: PlanRun | null;
  completedAt: string;
};

const environmentFacts = [
  "The application under test is DiffSense running WITHOUT credentials: OPENAI_API_KEY and DATABASE_URL are not configured.",
  "GET /api/status returns ready:false, so the header pill reads \"Setup required\", the inline setup hint is visible, the footer says the pipeline is not configured,",
  "and the Index repository context, Analyze change, and Generate Playwright plan buttons stay disabled. Reviews, indexing, and plan generation cannot run.",
  "Committed evaluation results are read from disk, so the metric tiles and evaluation panel show stored numbers. No user is signed in.",
].join(" ");

function scenariosFor(): Scenario[] {
  if (set === "holdout") {
    const definition = JSON.parse(readFileSync(join(v2Root, "scenarios.json"), "utf8")) as { scenarios: { id: string; role: string; intendedBreak: string }[] };
    return definition.scenarios.map((item) => ({ ...item, patchPath: join(v2Root, `${item.id}.patch`) }));
  }
  const definition = JSON.parse(readFileSync(join(regressionsRoot, "scenarios.json"), "utf8")) as { scenarios: { id: string; intendedBreak: string }[] };
  const roundOne = definition.scenarios
    .map((item) => ({ item, record: readJson<{ status: string; baselineRuns: PlanRun[] }>(join(regressionsRoot, "runs", `${item.id}.json`)) }))
    .filter(({ record }) => record && record.status !== "infra-invalid");
  const selected = set === "dev" ? roundOne : roundOne.filter(({ record }) => (record?.baselineRuns.length ?? 0) === 2);
  return selected.map(({ item }) => ({ id: item.id, role: "breaking", intendedBreak: item.intendedBreak, patchPath: join(regressionsRoot, `${item.id}.patch`) }));
}

async function captureSnapshot(port: number) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
    return (await page.locator("body").ariaSnapshot()).slice(0, 8_000);
  } finally {
    await browser.close();
  }
}

// Playwright rejects duplicate test titles, so each run copy numbers its scenarios.
function writeRunPlan(path: string, plan: { scenarios: { title: string }[] }, keep?: Set<string>) {
  const numbered = plan.scenarios.map((scenario, index) => ({ ...scenario, title: `${index + 1}. ${scenario.title}` }));
  writeJson(path, { scenarios: keep ? numbered.filter((scenario) => keep.has(`generated plan: ${scenario.title}`)) : numbered });
}

function survivingTests(runs: PlanRun[]) {
  const passedEverywhere = runs[0].tests.filter((test) => test.outcome === "pass").map((test) => test.title);
  return passedEverywhere.filter((title) => runs.slice(1).every((runResult) => runResult.tests.some((test) => test.title === title && test.outcome === "pass")));
}

async function main() {
  const base = process.env.DIFFSENSE_REGRESSION_BASE;
  if (!base || !/^[0-9a-f]{40}$/.test(base)) throw new Error("Set DIFFSENSE_REGRESSION_BASE to the full SHA of a pushed commit.");
  git(root, "fetch", "origin", "main");
  if (!git(root, "branch", "-r", "--contains", base).split("\n").some((branch) => branch.trim() === "origin/main")) throw new Error(`${base} is not on origin/main.`);
  if (git(root, "ls-tree", "-r", "--name-only", base).split("\n").some((path) => /(^|\/)\.env(?!\.example$)/.test(path))) throw new Error("A .env file is tracked at the base commit.");
  const scenarios = scenariosFor();
  console.log(JSON.stringify({ phase: "regressions v2 preflight", set, base, scenarios: scenarios.length, maximumCalls: set === "replay-v1" ? 0 : 2 * scenarios.length + 2 }, null, 2));

  const budget = set === "replay-v1" ? null : await createSessionBudget(`regressions-v2-${set}`);
  const contextModule = await import("../src/lib/server/context");
  const planModule = await import("../src/lib/server/test-plan");

  const baselineDirectory = prepareWorktree(`v2-baseline-${base.slice(0, 7)}`, base);
  const baselineBuild = build(baselineDirectory);
  if (!baselineBuild.ok) throw new Error(`Baseline build failed:\n${baselineBuild.output.slice(-3000)}`);
  let baselineServer: ChildProcess | null = startServer(baselineDirectory, baselinePort);
  if (!await waitForServer(baselinePort)) throw new Error("Baseline server did not start.");
  // Per-base name, so dependencies are installed from the same lockfile as the baseline build.
  const patchedDirectory = prepareWorktree(`v2-patched-${base.slice(0, 7)}`, base);

  let environment = "";
  if (set !== "replay-v1") {
    if (await contextModule.getIndexedCommit(repository) !== base) {
      const indexed = await contextModule.indexRepository(owner, repositoryName, base, budget ?? undefined);
      writeJson(join(v2Root, `index-${set}.json`), { ...indexed, indexedAt: new Date().toISOString() });
    }
    environment = `${environmentFacts}\n\nAccessibility snapshot of / after load:\n${await captureSnapshot(baselinePort)}`;
    writeJson(join(v2Root, `environment-${set}.json`), { environment });
  }

  try {
    for (const scenario of scenarios) {
      const recordPath = join(runsRoot, `${scenario.id}.json`);
      if (readJson<Record>(recordPath)) { console.log(`SKIP ${scenario.id}`); continue; }
      const finish = (record: Omit<Record, "id" | "role" | "intendedBreak" | "completedAt">) => {
        writeJson(recordPath, { id: scenario.id, role: scenario.role, intendedBreak: scenario.intendedBreak, ...record, completedAt: new Date().toISOString() });
        console.log(`RESULT ${scenario.id} (${scenario.role}): ${record.status} (${record.reason})`);
      };

      git(patchedDirectory, "reset", "--hard", base);
      git(patchedDirectory, "clean", "-fdx", "-e", "node_modules");
      const apply = run("git", ["-c", "core.autocrlf=false", "apply", scenario.patchPath], patchedDirectory);
      if (!apply.ok) { finish({ status: "infra-invalid", reason: `patch did not apply: ${apply.output.slice(0, 300)}`, generation: null, baselineRuns: [], surviving: [], patchedRun: null }); continue; }
      const patchedBuild = build(patchedDirectory);
      if (!patchedBuild.ok) { finish({ status: "infra-invalid", reason: `patched build failed: ${patchedBuild.output.slice(-300)}`, generation: null, baselineRuns: [], surviving: [], patchedRun: null }); continue; }

      const planPath = join(plansRoot, `${scenario.id}.json`);
      const runPlanPath = join(plansRoot, `${scenario.id}.run.json`);
      let generation: Record["generation"] = null;
      let baselineRuns: PlanRun[];
      if (set === "replay-v1") {
        // Post-hoc: Round-1 v1 plan and its two recorded baseline runs; only already-surviving scenarios are run on the patch.
        const plan = JSON.parse(readFileSync(join(regressionsRoot, "plans", `${scenario.id}.json`), "utf8")) as { scenarios: { title: string }[] };
        const roundOne = readJson<{ baselineRuns: PlanRun[] }>(join(regressionsRoot, "runs", `${scenario.id}.json`));
        baselineRuns = roundOne?.baselineRuns ?? [];
        writeJson(runPlanPath, { scenarios: plan.scenarios.filter((item) => survivingTests(baselineRuns).includes(`generated plan: ${item.title}`)) });
      } else {
        const saved = readJson<{ plan: { scenarios: { title: string }[] }; generation: Record["generation"] }>(`${planPath}.meta`);
        try {
          if (saved) {
            generation = saved.generation;
          } else {
            const diff = readFileSync(scenario.patchPath, "utf8").trim();
            const context = await contextModule.retrieveRepositoryContextDetailed(repository, diff, budget ?? undefined);
            const generated = await planModule.generateRegressionPlan(diff, context.chunks, budget ?? undefined, { revision: "v2", environment });
            generation = { scenarios: generated.plan.scenarios.length, dropped: generated.dropped, usage: generated.usage };
            writeJson(planPath, generated.plan);
            writeJson(`${planPath}.meta`, { plan: generated.plan, generation });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/cap would be exceeded/.test(message)) throw error;
          const rejected = error && typeof error === "object" && "rejectedOutput" in error ? String(error.rejectedOutput) : null;
          if (rejected) writeJson(join(plansRoot, `${scenario.id}.rejected.json`), JSON.parse(rejected));
          finish({ status: isApiError(error) ? "infra-invalid" : "invalid-plan", reason: `plan generation failed: ${message.slice(0, 300)}`, generation: null, baselineRuns: [], surviving: [], patchedRun: null });
          continue;
        }
        writeRunPlan(runPlanPath, JSON.parse(readFileSync(planPath, "utf8")));
        if (!await waitForServer(baselinePort, 2_000)) {
          stopServer(baselineServer);
          baselineServer = startServer(baselineDirectory, baselinePort);
          if (!await waitForServer(baselinePort)) throw new Error("Baseline server stopped and could not restart.");
        }
        baselineRuns = [runPlan(runPlanPath, baselinePort), runPlan(runPlanPath, baselinePort)];
        if (baselineRuns.some((item) => item.outcome === "infra")) { finish({ status: "infra-invalid", reason: "infrastructure failure on baseline", generation, baselineRuns, surviving: [], patchedRun: null }); continue; }
        const surviving = survivingTests(baselineRuns);
        writeRunPlan(runPlanPath, JSON.parse(readFileSync(planPath, "utf8")), new Set(surviving));
      }

      const surviving = survivingTests(baselineRuns);
      if (surviving.length === 0) { finish({ status: "invalid-plan", reason: "no scenario passed both baseline runs", generation, baselineRuns, surviving, patchedRun: null }); continue; }
      const patchedServer = startServer(patchedDirectory, patchedPort);
      let patchedRun: PlanRun | null = null;
      try {
        if (!await waitForServer(patchedPort)) { finish({ status: "infra-invalid", reason: "patched server did not start", generation, baselineRuns, surviving, patchedRun: null }); continue; }
        patchedRun = runPlan(runPlanPath, patchedPort);
      } finally {
        stopServer(patchedServer);
        await new Promise((done) => setTimeout(done, 1_000));
      }
      const benign = scenario.role === "benign";
      if (patchedRun.outcome === "infra") finish({ status: "infra-invalid", reason: "infrastructure failure on patched app", generation, baselineRuns, surviving, patchedRun });
      else if (patchedRun.outcome === "assertion") finish({ status: benign ? "false-alarm" : "detected", reason: "a surviving scenario failed an assertion on the patched app", generation, baselineRuns, surviving, patchedRun });
      else finish({ status: benign ? "no-alarm" : "not-detected", reason: patchedRun.outcome === "pass" ? "surviving scenarios passed on the patched app" : "only click/fill steps failed on the patched app", generation, baselineRuns, surviving, patchedRun });
    }
  } finally {
    stopServer(baselineServer);
  }

  const records = scenarios.map((scenario) => readJson<Record>(join(runsRoot, `${scenario.id}.json`))).filter((record): record is Record => record !== null);
  const count = (status: Status, role?: string) => records.filter((record) => record.status === status && (!role || record.role === role)).length;
  const breaking = records.filter((record) => record.role !== "benign" && record.status !== "infra-invalid");
  const benign = records.filter((record) => record.role === "benign" && record.status !== "infra-invalid");
  writeJson(join(v2Root, `results-${set}.json`), {
    schemaVersion: 1,
    set,
    baseSha: base,
    protocol: "evaluation/ROUND2.md (R5/R6, protocol v2)",
    generator: set === "replay-v1" ? "v1 plans from Round 1 (post-hoc replay)" : `v2 (${planModule.getTestPlanPromptHash("v2")})`,
    summary: {
      breakingValid: breaking.length,
      detected: count("detected"),
      notDetected: count("not-detected"),
      invalidPlansBreaking: breaking.filter((record) => record.status === "invalid-plan").length,
      benignValid: benign.length,
      falseAlarms: count("false-alarm"),
      noAlarm: count("no-alarm"),
      invalidPlansBenign: benign.filter((record) => record.status === "invalid-plan").length,
      infraInvalid: count("infra-invalid"),
    },
    scenarios: records.map((record) => ({ id: record.id, role: record.role, status: record.status, reason: record.reason, surviving: record.surviving.length })),
  });
  console.log(`SUMMARY ${set}: detected ${count("detected")}/${breaking.length} breaking; false alarms ${count("false-alarm")}/${benign.length} benign; infra-invalid ${count("infra-invalid")}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
