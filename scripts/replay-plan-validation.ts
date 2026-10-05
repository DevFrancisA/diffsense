import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateGeneratedPlan } from "../src/lib/server/test-plan";

// R4 (evaluation/ROUND2.md): replays Round-1 generator outputs that v1 validation rejected through v2 normalization and
// per-scenario validation. No API calls; this measures validation only, not whether the salvaged plans would run.
const plansRoot = join(process.cwd(), "evaluation", "regressions", "plans");
const rows = readdirSync(plansRoot).filter((name) => name.endsWith(".rejected.json")).sort().map((name) => {
  const raw = JSON.parse(readFileSync(join(plansRoot, name), "utf8")) as { scenarios: unknown[] };
  try {
    const { plan, dropped } = validateGeneratedPlan(raw, "v2");
    return { id: name.replace(".rejected.json", ""), salvaged: true, scenarios: raw.scenarios.length, kept: plan.scenarios.length, dropped };
  } catch (error) {
    return { id: name.replace(".rejected.json", ""), salvaged: false, scenarios: raw.scenarios.length, kept: 0, dropped: [{ title: "(all)", reason: error instanceof Error ? error.message : String(error) }] };
  }
});
const summary = {
  rejectedPlansReplayed: rows.length,
  plansSalvaged: rows.filter((row) => row.salvaged).length,
  scenariosTotal: rows.reduce((total, row) => total + row.scenarios, 0),
  scenariosKept: rows.reduce((total, row) => total + row.kept, 0),
  note: "Round-1 rejected outputs saved for r07 onward; r01-r04 outputs were not saved (see regressions/PROTOCOL.md).",
};
writeFileSync(join(process.cwd(), "evaluation", "regressions", "replay-validation-v2.json"), `${JSON.stringify({ summary, rows }, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));
for (const row of rows) console.log(`${row.id}: ${row.salvaged ? `kept ${row.kept}/${row.scenarios}` : "not salvaged"}${row.dropped.length ? ` | dropped: ${row.dropped.map((item) => item.reason).join("; ")}` : ""}`);
