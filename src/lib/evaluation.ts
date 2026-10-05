import { z } from "zod";

const findingSchema = z.object({ file: z.string().min(1), line: z.number().int().positive() });
const defectRangeSchema = z.object({
  file: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
}).refine((defect) => defect.endLine >= defect.startLine, "endLine must be greater than or equal to startLine");
const defectSchema = z.union([findingSchema, defectRangeSchema]);

export const evaluationSchema = z.object({
  pullRequests: z.array(z.object({
    id: z.string().min(1),
    knownDefects: z.array(defectSchema),
    manualFindings: z.array(findingSchema),
    assistedFindings: z.array(findingSchema),
    manualMinutes: z.number().positive().optional(),
    assistedMinutes: z.number().positive().optional(),
  }).superRefine((pullRequest, context) => {
    if ((pullRequest.manualMinutes === undefined) !== (pullRequest.assistedMinutes === undefined)) {
      context.addIssue({ code: "custom", message: "Provide both manualMinutes and assistedMinutes, or omit both." });
    }
  })),
  regressionScenarios: z.array(z.object({ id: z.string().min(1), detected: z.boolean() })).default([]),
});

type Finding = z.infer<typeof findingSchema>;
type Defect = { file: string; startLine: number; endLine: number };
export type EvaluationInput = z.input<typeof evaluationSchema>;

function normalizeDefect(defect: z.infer<typeof defectSchema>): Defect {
  if ("line" in defect) return { file: defect.file, startLine: defect.line, endLine: defect.line };
  return defect;
}

function countMatchedFindings(expected: Defect[], actual: Finding[]) {
  const unmatched = [...actual];
  let matched = 0;
  for (const defect of expected) {
    let closestIndex = -1;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < unmatched.length; index += 1) {
      const candidate = unmatched[index];
      const distance = candidate.line < defect.startLine
        ? defect.startLine - candidate.line
        : candidate.line > defect.endLine
          ? candidate.line - defect.endLine
          : 0;
      if (candidate.file === defect.file && distance <= 2 && distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    }
    if (closestIndex >= 0) {
      unmatched.splice(closestIndex, 1);
      matched += 1;
    }
  }
  return matched;
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function evaluate(input: EvaluationInput) {
  let knownDefects = 0;
  let assistedFindings = 0;
  let manualFindings = 0;
  let assistedDefectsFound = 0;
  let manualDefectsFound = 0;
  const pairedTimeSavings: number[] = [];
  const perPullRequest = input.pullRequests.map((pullRequest) => {
    const known = pullRequest.knownDefects.map(normalizeDefect);
    const assistedMatches = countMatchedFindings(known, pullRequest.assistedFindings);
    const manualMatches = countMatchedFindings(known, pullRequest.manualFindings);
    knownDefects += known.length;
    assistedFindings += pullRequest.assistedFindings.length;
    manualFindings += pullRequest.manualFindings.length;
    assistedDefectsFound += assistedMatches;
    manualDefectsFound += manualMatches;

    const manualMinutes = pullRequest.manualMinutes;
    const assistedMinutes = pullRequest.assistedMinutes;
    const timeSavings = manualMinutes !== undefined && assistedMinutes !== undefined
      ? ((manualMinutes - assistedMinutes) / manualMinutes) * 100
      : null;
    if (timeSavings !== null) pairedTimeSavings.push(timeSavings);

    return {
      id: pullRequest.id,
      knownDefects: known.length,
      manualFindings: pullRequest.manualFindings.length,
      assistedFindings: pullRequest.assistedFindings.length,
      manualDefectsFound: manualMatches,
      assistedDefectsFound: assistedMatches,
      falsePositives: pullRequest.assistedFindings.length - assistedMatches,
      precision: pullRequest.assistedFindings.length === 0 ? null : assistedMatches / pullRequest.assistedFindings.length,
      recall: known.length === 0 ? null : assistedMatches / known.length,
      manualMinutes: pullRequest.manualMinutes ?? null,
      assistedMinutes: pullRequest.assistedMinutes ?? null,
      reviewTimeSavingsPercent: timeSavings,
    };
  });

  const regressionScenarios = input.regressionScenarios ?? [];
  const caughtRegressions = regressionScenarios.filter((scenario) => scenario.detected).length;
  return {
    pullRequests: input.pullRequests.length,
    precision: assistedFindings === 0 ? null : assistedDefectsFound / assistedFindings,
    recall: knownDefects === 0 ? null : assistedDefectsFound / knownDefects,
    reviewTimeSavingsMedianPercent: median(pairedTimeSavings),
    pairedReviewTasks: pairedTimeSavings.length,
    manualDefectsFound,
    assistedDefectsFound,
    falsePositives: assistedFindings - assistedDefectsFound,
    knownDefects,
    seededRegressions: regressionScenarios.length,
    regressionCatchRate: regressionScenarios.length === 0 ? null : caughtRegressions / regressionScenarios.length,
    caughtRegressions,
    findings: { manual: manualFindings, assisted: assistedFindings },
    perPullRequest,
  };
}