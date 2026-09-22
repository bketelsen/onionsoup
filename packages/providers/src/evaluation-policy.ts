// The model every capability runs on. Override with ONIONSOUP_MODEL; records keep the model they ran with.
export const EVALUATION_MODEL: string = process.env.ONIONSOUP_MODEL ?? 'gpt-5.6-terra';
export function assertEvaluationModels(models: string[]) {
  if (models.length !== 1 || models[0] !== EVALUATION_MODEL)
    throw new Error(`Current evaluations use ${EVALUATION_MODEL} only. Historical comparisons remain available for reporting and feedback.`);
}
