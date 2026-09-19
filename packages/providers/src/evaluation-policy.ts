// One model for development evaluations. Model comparison is deferred.
export const EVALUATION_MODEL = 'gpt-5.6-terra';
export function assertEvaluationModels(models: string[]) {
  if (models.length !== 1 || models[0] !== EVALUATION_MODEL)
    throw new Error('Current evaluations use gpt-5.6-terra only. Historical comparisons remain available for reporting and feedback.');
}
