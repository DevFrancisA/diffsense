import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Joins the two blind judges' answers (evaluation/audit/judgments.json) with the key (evaluation/audit/key.json)
// and tallies per configuration. All judgments are by Claude agents, not humans (evaluation/ROUND2.md, R2/R7).
type Key = { id: string; config: string; caseId: string; run: number; file: string; line: number };
type AuditJudgment = { id: string; describesDefect: boolean; restoreOnly: boolean; note: string };
type FlagJudgment = { id: string; verdict: "real-defect" | "not-a-defect" | "unsure"; note: string };
type Batch = { kind: "audit" | "flag"; judge: "A" | "B"; ids: string[]; judgments: (AuditJudgment | FlagJudgment)[] | null };

const auditRoot = join(process.cwd(), "evaluation", "audit");
const key = JSON.parse(readFileSync(join(auditRoot, "key.json"), "utf8")) as Key[];
const batches = JSON.parse(readFileSync(join(auditRoot, "judgments.json"), "utf8")) as Batch[];

const byJudge = { A: new Map<string, AuditJudgment | FlagJudgment>(), B: new Map<string, AuditJudgment | FlagJudgment>() };
const problems: string[] = [];
for (const batch of batches) {
  if (!batch.judgments) { problems.push(`${batch.kind} judge ${batch.judge}: batch returned nothing (${batch.ids.join(", ")})`); continue; }
  for (const id of batch.ids) {
    const judgment = batch.judgments.find((item) => item.id === id);
    if (judgment) byJudge[batch.judge].set(id, judgment);
    else problems.push(`${batch.kind} judge ${batch.judge}: no judgment for ${id}`);
  }
}

const configs = [...new Set(key.map((item) => item.config))];
const summary = configs.map((config) => {
  const items = key.filter((item) => item.config === config);
  const pairs = items.map((item) => ({ item, a: byJudge.A.get(item.id), b: byJudge.B.get(item.id) })).filter((pair) => pair.a && pair.b);
  if (config.startsWith("forward-")) {
    const verdicts = pairs.map(({ a, b }) => [(a as FlagJudgment).verdict, (b as FlagJudgment).verdict]);
    return {
      config,
      items: items.length,
      judgedByBoth: pairs.length,
      agreement: verdicts.filter(([a, b]) => a === b).length,
      bothRealDefect: verdicts.filter(([a, b]) => a === "real-defect" && b === "real-defect").length,
      bothNotADefect: verdicts.filter(([a, b]) => a === "not-a-defect" && b === "not-a-defect").length,
      disagreeOrUnsure: verdicts.filter(([a, b]) => a !== b || a === "unsure").length,
    };
  }
  const answers = pairs.map(({ a, b }) => [a as AuditJudgment, b as AuditJudgment]);
  return {
    config,
    items: items.length,
    judgedByBoth: pairs.length,
    describesDefect: {
      agreement: answers.filter(([a, b]) => a.describesDefect === b.describesDefect).length,
      bothYes: answers.filter(([a, b]) => a.describesDefect && b.describesDefect).length,
      bothNo: answers.filter(([a, b]) => !a.describesDefect && !b.describesDefect).length,
    },
    restoreOnly: {
      agreement: answers.filter(([a, b]) => a.restoreOnly === b.restoreOnly).length,
      bothYes: answers.filter(([a, b]) => a.restoreOnly && b.restoreOnly).length,
      bothNo: answers.filter(([a, b]) => !a.restoreOnly && !b.restoreOnly).length,
    },
  };
});
writeFileSync(join(auditRoot, "summary.json"), `${JSON.stringify({ judges: "two independent Claude agents per item, blind to configuration; not human-reviewed", problems, summary }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ problems, summary }, null, 2));
