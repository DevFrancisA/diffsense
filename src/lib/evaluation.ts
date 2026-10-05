import { z } from "zod";

const findingSchema = z.object({ file: z.string().min(1), line: z.number().int().positive() });

export const evaluationSchema = z.object({
  pullRequests: z.array(z.object({
    id: z.string().min(1),
    knownDefects: z.array(findingSchema),
    manualFindings: z.array(findingSchema),
    assistedFindings: z.array(findingSchema),
    manualMinutes: z.number().positive(),
    assistedMinutes: z.number().positive(),
  })),
  regressionScenarios: z.array(z.object({ id: z.string().min(1), detected: z.boolean() })),
});

type Finding = z.infer<typeof findingSchema>;
export type EvaluationInput = z.infer<typeof evaluationSchema>;

function countMatchedFindings(expected: Finding[], actual: Finding[]) {
  const unmatched = [...actual];
  let matched = 0;
  for (const defect of expected) {
    let closestIndex = -1;
    let closestDistance = 3;
    for (let index = 0; index < unmatched.length; index += 1) {
      const candidate = unmatched[index];
      const distance = Math.abs(candidate.line - defect.line);
      if (candidate.file === defect.file && distance < closestDistance) {
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
  const pairedTimeSavings = input.pullRequests.map((pullRequest) =>
    ((pullRequest.manualMinutes - pullRequest.assistedMinutes) / pullRequest.manualMinutes) * 100,
  );

  for (const pullRequest of input.pullRequests) {
    knownDefects += pullRequest.knownDefects.length;
    assistedFindings += pullRequest.assistedFindings.length;
    manualFindings += pullRequest.manualFindings.length;
    assistedDefectsFound += countMatchedFindings(pullRequest.knownDefects, pullRequest.assistedFindings);
    manualDefectsFound += countMatchedFindings(pullRequest.knownDefects, pullRequest.manualFindings);
  }

  const caughtRegressions = input.regressionScenarios.filter((scenario) => scenario.detected).length;
  return {
    pullRequests: input.pullRequests.length,
    precision: assistedFindings === 0 ? null : assistedDefectsFound / assistedFindings,
    recall: knownDefects === 0 ? null : assistedDefectsFound / knownDefects,
    reviewTimeSavingsMedianPercent: median(pairedTimeSavings),
    pairedReviewTasks: pairedTimeSavings.length,
    manualDefectsFound,
    assistedDefectsFound,
    knownDefects,
    seededRegressions: input.regressionScenarios.length,
    regressionCatchRate: input.regressionScenarios.length === 0 ? null : caughtRegressions / input.regressionScenarios.length,
    caughtRegressions,
    findings: { manual: manualFindings, assisted: assistedFindings },
  };
}