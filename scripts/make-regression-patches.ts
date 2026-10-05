import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Writes evaluation/regressions/<id>.patch for every scenario in scenarios.json, generated against one base commit.
type Scenario = { id: string; file: string; find: string; replace: string };

const root = process.cwd();
const base = process.argv[2] ?? "HEAD";
const scenarios = (JSON.parse(readFileSync(join(root, "evaluation", "regressions", "scenarios.json"), "utf8")) as { scenarios: Scenario[] }).scenarios;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" });

const worktree = join(mkdtempSync(join(tmpdir(), "diffsense-patches-")), "tree");
git(root, "worktree", "add", "--detach", worktree, base);
try {
  for (const scenario of scenarios) {
    const filePath = join(worktree, scenario.file);
    const original = readFileSync(filePath, "utf8");
    if (original.split(scenario.find).length !== 2) throw new Error(`${scenario.id}: find text must occur exactly once in ${scenario.file}.`);
    writeFileSync(filePath, original.replace(scenario.find, () => scenario.replace), "utf8");
    const patch = git(worktree, "diff", "--", scenario.file);
    if (!patch.trim()) throw new Error(`${scenario.id}: replacement produced no diff.`);
    writeFileSync(join(root, "evaluation", "regressions", `${scenario.id}.patch`), patch, "utf8");
    git(worktree, "checkout", "--", scenario.file);
  }
  console.log(`Wrote ${scenarios.length} patches against ${git(root, "rev-parse", base).trim()}.`);
} finally {
  git(root, "worktree", "remove", "--force", worktree);
  rmSync(join(worktree, ".."), { recursive: true, force: true });
}
