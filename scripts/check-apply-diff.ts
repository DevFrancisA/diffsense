import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadEnvConfig } from "@next/env";
import { applyDiffToFile, getChangedFileContext } from "../src/lib/server/context";
import { getRawRepositoryFile } from "../src/lib/server/github";

loadEnvConfig(process.cwd());

// Round 3 check (no OpenAI calls): applying each cached BugsJS diff to its pre-change files must reproduce the files at the
// post-change commit exactly. Reversed diffs go fix -> buggy; forward diffs go buggy -> fix.
type ManifestCase = { project: string; upstreamRepository: string; bugId: number; fixSha: string; buggySha: string };
const diffRoot = join(resolve(process.env.DIFFSENSE_BENCHMARK_CACHE ?? join(tmpdir(), "diffsense-benchmark-cache")), "diffs");

async function main() {
  const failures: string[] = [];
  let checked = 0;
  for (const manifestFile of ["manifest.json", "manifest-holdout.json"]) {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "evaluation", manifestFile), "utf8")) as { cases: ManifestCase[] };
    for (const item of manifest.cases) {
      const [owner, repository] = item.upstreamRepository.split("/").slice(-2);
      const slug = `${item.project.replace(/[^a-z0-9]+/gi, "-")}-${item.bugId}`;
      for (const [suffix, before, after] of [["", item.fixSha, item.buggySha], [".forward", item.buggySha, item.fixSha]] as const) {
        let diff: string;
        try { diff = readFileSync(join(diffRoot, `${slug}${suffix}.diff`), "utf8"); } catch { continue; }
        for (const file of await getChangedFileContext(owner, repository, before, diff)) {
          const applied = applyDiffToFile(diff, file.path, file.content);
          let expected: string;
          try {
            expected = (await getRawRepositoryFile(owner, repository, after, file.path)).split(/\r?\n/).join("\n");
          } catch {
            continue; // the change deletes this file
          }
          checked += 1;
          if (applied !== expected) failures.push(`${slug}${suffix} ${file.path}`);
        }
      }
    }
  }
  console.log(JSON.stringify({ filesChecked: checked, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
