import type { OperatorHandoffReport } from './operator-handoff-host.ts';

export const OPERATOR_HANDOFF_VIEW_LIMITS = { diffChars: 12_000, outputChars: 1_000, responseChars: 32_000 };

/** The complete immutable diff and evidence live in the report; tool output is an explicitly bounded preview. */
export function operatorHandoffToolView(report: OperatorHandoffReport) {
  const summary = { kind: report.kind, application: report.application, status: report.status, current: report.current,
    observedAt: report.observedAt, reason: report.reason, paths: report.paths, digest: report.artifact.digest,
    checks: report.checks.map(check => ({ id: check.id, checkID: check.checkID, status: check.status,
      exitCode: check.exitCode, digest: check.digest })),
    resolutions: report.resolutions.map(resolution => ({ receiptID: resolution.receiptID, kind: resolution.kind, at: resolution.at })),
    recovery: { previewAction: 'recovery-preview-handoff', action: 'recover-handoff' },
    commands: report.artifact.checks.map(check => ({ id: check.id, command: check.command,
      provenance: check.provenance })),
    completeEvidence: 'This is a timestamped observation; call show-handoff to refresh after a pending check. The JSON report contains the complete artifact, approvals, child evidence and check receipts. The patch contains the exact combined diff. Neither has been applied.' };
  const preview = { ...summary, goal: report.artifact.goal, base: report.artifact.base,
    diffPreview: report.artifact.diff.slice(0, OPERATOR_HANDOFF_VIEW_LIMITS.diffChars),
    diffPreviewTruncated: report.artifact.diff.length > OPERATOR_HANDOFF_VIEW_LIMITS.diffChars,
    checkOutputPreviews: report.checks.map(check => ({ id: check.id,
      output: check.output?.slice(0, OPERATOR_HANDOFF_VIEW_LIMITS.outputChars),
      truncated: Boolean(check.outputTruncated || (check.output?.length ?? 0) > OPERATOR_HANDOFF_VIEW_LIMITS.outputChars) })) };
  if (JSON.stringify(preview).length <= OPERATOR_HANDOFF_VIEW_LIMITS.responseChars) return preview;
  return { ...summary, commands: summary.commands.map(check => ({ id: check.id, provenance: check.provenance })),
    previewOmitted: 'Read the complete report and patch at the returned paths; the tool preview exceeded its size limit.' };
}
