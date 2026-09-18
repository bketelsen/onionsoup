import { z } from 'zod';
import { IssueSnapshot, validateAssessment } from './contracts.ts';
import { validateLegacyAssessment } from './legacy-contracts.ts';
import { inputHash } from './triage.ts';
import type { StoredRunRecord } from './assessment-view.ts';
const Id = z.string().uuid();
export function validateReadinessRun(raw: unknown): StoredRunRecord {
  const r = raw as StoredRunRecord;
  if (!r || ![1, 2].includes(r.schemaVersion) || r.agent !== 'bug-readiness' ||
      !Id.safeParse(r.runId).success || !r.provider || !r.model || !r.promptVersion || !['running', 'completed', 'failed'].includes(r.status) ||
      !z.iso.datetime().safeParse(r.startedAt).success || !Array.isArray(r.events) ||
      (r.status !== 'running' && !z.iso.datetime().safeParse(r.finishedAt).success)) throw new Error('Invalid readiness record');
  const input = IssueSnapshot.parse(r.input);
  if (r.inputHash !== inputHash(input)) throw new Error('Readiness input identity mismatch');
  if (r.status === 'completed') {
    if (r.schemaVersion === 1) validateLegacyAssessment(r.assessment, input);
    else validateAssessment(r.assessment, input);
  } else if (r.assessment) throw new Error('Unfinished readiness has an assessment');
  return r;
}
