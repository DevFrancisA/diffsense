import type { ApiTokenUsage, OpenAIBudget } from "@/lib/server/ai";
import { getChangedFileContext, retrieveRepositoryContextDetailed } from "@/lib/server/context";
import type { AcceptancePolicy, ReviewPromptRevision } from "@/lib/server/review";

export type ReviewPipelineConfig = {
  promptRevision: ReviewPromptRevision;
  includeChangedFiles: boolean;
  changedFilesExcludeTests: boolean;
  retrievalK: number;
  acceptance: AcceptancePolicy;
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
  const retrieved = await retrieveRepositoryContextDetailed(input.repositoryKey, input.diff, input.budget, input.config.retrievalK);
  let changedFiles = input.config.includeChangedFiles
    ? await getChangedFileContext(input.owner, input.repository, input.baseCommit, input.diff, { excludeTests: input.config.changedFilesExcludeTests })
    : [];
  let total = 0;
  changedFiles = changedFiles.filter((file) => (total += file.content.length) <= maxChangedFileChars);
  const context = [...changedFiles.map((file) => ({ path: `${file.path} (full file before this change)`, content: file.content })), ...retrieved.chunks];
  const embeddingUsage: ApiTokenUsage = retrieved.embeddingUsage;
  return { context, chunks: retrieved.chunks, changedFiles, embeddingUsage };
}
