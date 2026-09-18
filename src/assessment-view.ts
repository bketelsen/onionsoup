import type { Assessment } from './contracts.ts';
import type { LegacyAssessment } from './legacy-contracts.ts';
import type { RunRecord } from './triage.ts';

export type StoredRunRecord = RunRecord | (Omit<RunRecord, 'schemaVersion' | 'assessment'> & {
  schemaVersion: 1; assessment?: LegacyAssessment;
});
type StoredAssessment = Assessment | LegacyAssessment;

export function readiness(assessment?: StoredAssessment) {
  if (!assessment) return undefined;
  return 'bug_readiness' in assessment ? assessment.bug_readiness : assessment.disposition;
}
export function requestKind(assessment?: StoredAssessment) {
  if (!assessment) return undefined;
  // Version 1 did not distinguish feature requests, support, or unrelated text.
  return 'kind' in assessment ? assessment.kind : 'unclassified_legacy';
}
export function assessmentLabel(assessment?: StoredAssessment) {
  if (!assessment) return undefined;
  return 'kind' in assessment ? `${assessment.kind} · ${assessment.bug_readiness}` :
    `${assessment.disposition} (legacy v1)`;
}
