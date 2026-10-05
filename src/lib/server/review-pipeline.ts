import type { ApiTokenUsage, OpenAIBudget } from "@/lib/server/ai";
import { applyDiffToFile, diffAppliesToFile, getChangedFileContext, retrieveRepositoryContextDetailed } from "@/lib/server/context";
import type { AcceptancePolicy, ReviewPromptRevision } from "@/lib/server/review";

export type ReviewPipelineConfig = {
  promptRevision: ReviewPromptRevision;
  includeChangedFiles: boolean;
  changedFilesExcludeTests: boolean;
  retrievalK: number;
  acceptance: AcceptancePolicy;
  /** Which side of the change the full changed files show; Round 3 (C5) uses "after". Defaults to "before". */
  changedFileSide?: "before" | "after";
};

/** The original 2026-10-05 baseline pipeline. */
export const baselineReviewConfig: ReviewPipelineConfig = {
  promptRevision: "baseline",
  includeChangedFiles: false,
  changedFilesExcludeTests: false,
  retrievalK: 8,
  acceptance: "exact",
};

/** C4 (evaluation/ROUND2.md): C3's context and prompt with removed-line citations remapped to their hunk's added line. */
export const finalReviewConfig: ReviewPipelineConfig = {
  promptRevision: "cite-added-line-source-focus",
  includeChangedFiles: true,
  changedFilesExcludeTests: true,
  retrievalK: 8,
  acceptance: "remap-removed",
};

/** The app's toggle for reviewing test files keeps everything else from the final configuration. */
export function appReviewConfig(skipTestFiles: boolean): ReviewPipelineConfig {
  return skipTestFiles
    ? finalReviewConfig
    : { ...finalReviewConfig, promptRevision: "cite-added-line", changedFilesExcludeTests: false };
}

// Three changed files at the 80 KB per-file limit; never binding on the BugsJS cohorts (at most three source files each).
const maxChangedFileChars = 240_000;

/**
 * Builds the review context exactly as measured: the full pre-change text of changed files (read at baseCommit, which must be
 * the pre-change side of the diff), followed by the top-k chunks retrieved from the index.
 */
export async function buildReviewContext(input: {
  owner: string;
  repository: string;
  repositoryKey: string;
  baseCommit: string;
  diff: string;
  config: ReviewPipelineConfig;
  budget?: OpenAIBudget;
}) {
  const retrieved = await retrieveRepositoryContextDetailed(input.repositoryKey, input.diff, input.budget, input.config.retrievalK, input.baseCommit);
  const fetched = input.config.includeChangedFiles
    ? await getChangedFileContext(input.owner, input.repository, input.baseCommit, input.diff, { excludeTests: input.config.changedFilesExcludeTests })
    : [];
  // A file is labelled "before this change" only if the diff's removed and context lines match it at baseCommit.
  let changedFiles = fetched.filter((file) => diffAppliesToFile(input.diff, file.path, file.content));
  const changedFilesSkipped = fetched.filter((file) => !changedFiles.includes(file)).map((file) => file.path);
  let total = 0;
  changedFiles = changedFiles.filter((file) => (total += file.content.length) <= maxChangedFileChars);
  const after = input.config.changedFileSide === "after";
  const fullFiles = changedFiles.map((file) => ({
    path: `${file.path} (full file ${after ? "after" : "before"} this change)`,
    content: after ? applyDiffToFile(input.diff, file.path, file.content) ?? file.content : file.content,
  }));
  const context = [...fullFiles, ...retrieved.chunks];
  const embeddingUsage: ApiTokenUsage = retrieved.embeddingUsage;
  return { context, chunks: retrieved.chunks, changedFiles, fullFiles, changedFilesSkipped, embeddingUsage };
}
