import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ApiTokenUsage, OpenAIBudget } from "../src/lib/server/ai";

// Session-wide ledger shared by every script that calls OpenAI after the 2026-10-05 baseline.
// The earlier per-date ledger (evaluation/runs/2026-10-05/budget.json) is left untouched.
export const sessionLedgerPath = join(process.cwd(), "evaluation", "ledger", "session-2.json");
export const sessionCallLimit = 1_000;
export const sessionTokenLimit = 10_000_000;

type LedgerEntry = { at: string; label: string; calls: number; estimatedTokens?: number; usage?: ApiTokenUsage };
type Ledger = {
  session: string;
  callLimit: number;
  tokenLimit: number;
  reservedCalls: number;
  completedCalls: number;
  estimatedInputTokens: number;
  observedInputTokens: number;
  observedOutputTokens: number;
  observedTotalTokens: number;
  byLabel: Record<string, { calls: number; totalTokens: number }>;
  log: LedgerEntry[];
};

async function writeJsonAtomic(filePath: string, value: unknown) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  // Windows briefly locks a file another process (git, an editor, a scanner) is reading; retry the replace.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temporaryPath, filePath);
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : "";
      if (attempt >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise((done) => setTimeout(done, 100 * attempt));
    }
  }
}

export async function readSessionLedger(): Promise<Ledger> {
  try {
    return JSON.parse(await readFile(sessionLedgerPath, "utf8")) as Ledger;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        session: "session-2",
        callLimit: sessionCallLimit,
        tokenLimit: sessionTokenLimit,
        reservedCalls: 0,
        completedCalls: 0,
        estimatedInputTokens: 0,
        observedInputTokens: 0,
        observedOutputTokens: 0,
        observedTotalTokens: 0,
        byLabel: {},
        log: [],
      };
    }
    throw error;
  }
}

/** Budget that refuses any batch which could push reserved calls or tokens past the session caps. */
export async function createSessionBudget(scope: string): Promise<OpenAIBudget & { ledger: Ledger }> {
  const ledger = await readSessionLedger();
  if (ledger.callLimit !== sessionCallLimit || ledger.tokenLimit !== sessionTokenLimit) throw new Error("Session ledger limits do not match this script.");
  return {
    ledger,
    async beforeBatch(label, apiCalls, estimatedTokens) {
      if (!Number.isSafeInteger(apiCalls) || apiCalls < 1 || !Number.isSafeInteger(estimatedTokens) || estimatedTokens < 0) {
        throw new Error(`Invalid API budget estimate for ${label}.`);
      }
      Object.assign(ledger, await readSessionLedger()); // another script may share this ledger
      const reservedCalls = ledger.reservedCalls + apiCalls;
      const projectedTokens = Math.max(ledger.observedTotalTokens, ledger.estimatedInputTokens) + estimatedTokens;
      console.log(`BUDGET ${scope}/${label}: ${apiCalls} call(s), ~${estimatedTokens} input tokens; session ${reservedCalls}/${sessionCallLimit} calls, ~${projectedTokens}/${sessionTokenLimit} tokens.`);
      if (reservedCalls > sessionCallLimit) throw new Error(`Session call cap would be exceeded (${reservedCalls} > ${sessionCallLimit}).`);
      if (projectedTokens > sessionTokenLimit) throw new Error(`Session token cap would be exceeded (~${projectedTokens} > ${sessionTokenLimit}).`);
      ledger.reservedCalls = reservedCalls;
      ledger.estimatedInputTokens += estimatedTokens;
      ledger.log.push({ at: new Date().toISOString(), label: `${scope}/${label}`, calls: apiCalls, estimatedTokens });
      await writeJsonAtomic(sessionLedgerPath, ledger);
    },
    async recordUsage(label, usage) {
      const key = `${scope}/${label}`;
      Object.assign(ledger, await readSessionLedger());
      ledger.completedCalls += 1;
      ledger.observedInputTokens += usage.inputTokens;
      ledger.observedOutputTokens += usage.outputTokens;
      ledger.observedTotalTokens += usage.totalTokens;
      ledger.byLabel[key] ??= { calls: 0, totalTokens: 0 };
      ledger.byLabel[key].calls += 1;
      ledger.byLabel[key].totalTokens += usage.totalTokens;
      ledger.log.push({ at: new Date().toISOString(), label: key, calls: 1, usage });
      await writeJsonAtomic(sessionLedgerPath, ledger);
    },
  };
}
