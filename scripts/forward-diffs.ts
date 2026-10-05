import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Writes the real fix diff (buggy -> fix) next to each cached reversed diff. Run after `npm run build-dataset`.
// Usage: tsx scripts/forward-diffs.ts [manifest.json|manifest-holdout.json]
type ManifestCase = { project: string; upstreamRepository: string; bugId: number; fixSha: string; buggySha: string };
const root = process.cwd();
const manifestFile = process.argv[2] ?? "manifest-holdout.json";
const cacheRoot = resolve(process.env.DIFFSENSE_BENCHMARK_CACHE ?? join(tmpdir(), "diffsense-benchmark-cache"));
const manifest = JSON.parse(readFileSync(join(root, "evaluation", manifestFile), "utf8")) as { cases: ManifestCase[] };
// Same options as scripts/build-dataset.ts.
const diffOptions = ["--no-ext-diff", "--no-renames", "--no-color", "--unified=0"];

for (const item of manifest.cases) {
  const repoPath = join(cacheRoot, "repos", item.upstreamRepository.split("/").slice(-2).join("-").toLowerCase());
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  const slug = `${item.project.replace(/[^a-z0-9]+/gi, "-")}-${item.bugId}`;
  const reversed = git("diff", ...diffOptions, item.fixSha, item.buggySha, "--");
  const cached = readFileSync(join(cacheRoot, "diffs", `${slug}.diff`), "utf8");
  if (reversed !== cached) throw new Error(`${slug}: regenerated reversed diff differs from the cached one; check the clone.`);
  const forward = git("diff", ...diffOptions, item.buggySha, item.fixSha, "--");
  writeFileSync(join(cacheRoot, "diffs", `${slug}.forward.diff`), forward, "utf8");
  console.log(`${slug}: forward diff ${forward.length} chars, sha256 ${createHash("sha256").update(forward).digest("hex").slice(0, 12)}`);
}
