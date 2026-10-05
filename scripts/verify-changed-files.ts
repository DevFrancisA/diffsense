import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadEnvConfig } from "@next/env";
import { diffAppliesToFile, getChangedFileContext } from "../src/lib/server/context";

loadEnvConfig(process.cwd());

// Confirms that the pre-change check added to buildReviewContext would have kept every full file the measured benchmark
// variants included (so it cannot change their results). GitHub reads only; no OpenAI calls.
const root = process.cwd();
const diffRoot = join(resolve(process.env.DIFFSENSE_BENCHMARK_CACHE ?? join(tmpdir(), "diffsense-benchmark-cache")), "diffs");
const variants = ["dev-c1", "dev-c2", "dev-c3", "holdout-final", "holdout-forward-final"];
async function main() {
  const failures: string[] = [];
  let checked = 0;
  for (const variant of variants) {
    const directory = join(root, "evaluation", "runs", "2026-10-05", variant);
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
      const record = JSON.parse(readFileSync(join(directory, file), "utf8")) as {
        caseId: string; upstreamRepository: string; index: { commitSha: string }; pipelineConfig?: { direction?: string; changedFilesExcludeTests?: boolean };
        context: { changedFileRefs?: { path: string; contentSha256: string }[] };
      };
      const [owner, repository] = record.upstreamRepository.split("/").slice(-2);
      const diffPath = join(diffRoot, `${record.caseId}${record.pipelineConfig?.direction === "forward" ? ".forward" : ""}.diff`);
      if (!existsSync(diffPath)) { failures.push(`${variant}/${record.caseId}: no cached diff`); continue; }
      const diff = readFileSync(diffPath, "utf8");
      const fetched = await getChangedFileContext(owner, repository, record.index.commitSha, diff, { excludeTests: record.pipelineConfig?.changedFilesExcludeTests === true });
      const stored = record.context.changedFileRefs ?? [];
      const fetchedRefs = fetched.map((item) => ({ path: item.path, contentSha256: createHash("sha256").update(item.content).digest("hex") }));
      if (JSON.stringify(fetchedRefs) !== JSON.stringify(stored)) failures.push(`${variant}/${record.caseId}: refetched files differ from the stored refs`);
      for (const item of fetched) {
        checked += 1;
        if (!diffAppliesToFile(diff, item.path, item.content)) failures.push(`${variant}/${record.caseId}: ${item.path} would now be skipped`);
      }
    }
  }
  console.log(JSON.stringify({ variants, filesChecked: checked, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
