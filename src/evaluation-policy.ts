// Legacy evaluation CLIs (triage, batch, inbox, briefing, location) compare runs on one pinned model.
// The job host chooses a model per agent instead; see packages/host-capabilities/src/models.ts.
export const EVALUATION_MODEL: string = process.env.ONIONSOUP_MODEL ?? 'gpt-5.6-terra';
export function assertEvaluationModels(models: string[]) {
  if (models.length !== 1 || models[0] !== EVALUATION_MODEL)
    throw new Error(`Current evaluations use ${EVALUATION_MODEL} only. Historical comparisons remain available for reporting and feedback.`);
}
