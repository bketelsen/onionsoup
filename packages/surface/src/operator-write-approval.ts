import { z } from 'zod';
import { OPERATOR_WRITE_PERMISSION, OperatorTaskCheck, OperatorCheckRecord } from '@onionsoup/owners';

const Workspace = z.object({ id: z.string(), directory: z.string(), head: z.string(), files: z.array(z.string()),
  createFiles: z.array(z.string()).default([]), checks: z.array(OperatorTaskCheck).default([]), goal: z.string().optional() });
const Common = z.object({ intake: z.string(), goal: z.string(), constraints: z.array(z.string()) });
const DiffApproval = Common.extend({ directory: z.string(), head: z.string(), diff: z.string(),
  files: z.array(z.string()), checks: z.array(OperatorCheckRecord).default([]) });
const ApplyScope = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), handoffDigest: z.string().regex(/^[a-f0-9]{64}$/),
  jobID: z.string().min(1), warning: z.string().min(1) });
export const OperatorWriteApproval = z.discriminatedUnion('mode', [
  Common.extend({ mode: z.literal('create-write'), workspaces: z.array(Workspace) }),
  DiffApproval.extend({ mode: z.literal('accept-write'),
    evidence: z.object({ sessionID: z.string(), messageID: z.string() }).optional() }),
  DiffApproval.extend({ mode: z.literal('apply-handoff'), ...ApplyScope.shape }),
]);
export type OperatorWriteApproval = z.infer<typeof OperatorWriteApproval>;
const CreateMetadata = z.object({ mode: z.literal('create-write'), intake: z.object({ text: z.string() }),
  input: z.object({ goal: z.string(), constraints: z.array(z.string()),
    tasks: z.array(z.object({ id: z.string(), goal: z.string() })).optional() }), workspaces: z.array(Workspace) });
const AcceptMetadata = z.object({ mode: z.literal('accept-write'), originalIntake: z.object({ text: z.string() }),
  goal: z.string(), constraints: z.array(z.string()), directory: z.string(),
  checks: z.array(OperatorCheckRecord).default([]),
  artifact: z.object({ head: z.string(), diff: z.string(), files: z.array(z.object({ path: z.string() })) }),
  evidence: z.object({ sessionID: z.string(), messageID: z.string() }).optional() });
const ApplyMetadata = AcceptMetadata.omit({ mode: true, evidence: true }).extend({
  mode: z.literal('apply-handoff'), ...ApplyScope.shape, checks: z.array(OperatorCheckRecord),
}).superRefine((metadata, context) => {
  if (metadata.checks.some(check => check.status !== 'completed' || check.exitCode !== 0
    || check.artifactDigest !== metadata.handoffDigest)) {
    context.addIssue({ code: 'custom', message: 'operator_apply_check_evidence_mismatch' });
  }
});
const Metadata = z.discriminatedUnion('mode', [CreateMetadata, AcceptMetadata, ApplyMetadata]);
type Metadata = z.infer<typeof Metadata>;
type Mode = Metadata['mode'];
type Projections = { [Key in Mode]: (metadata: Extract<Metadata, { mode: Key }>) => OperatorWriteApproval };

function diffApproval(metadata: z.infer<typeof AcceptMetadata> | z.infer<typeof ApplyMetadata>) {
  return { intake: metadata.originalIntake.text, goal: metadata.goal, constraints: metadata.constraints,
    directory: metadata.directory, head: metadata.artifact.head, diff: metadata.artifact.diff,
    files: metadata.artifact.files.map(file => file.path), checks: metadata.checks };
}
const projections: Projections = {
  'create-write': metadata => ({ mode: 'create-write', intake: metadata.intake.text, goal: metadata.input.goal,
    constraints: metadata.input.constraints, workspaces: metadata.workspaces.map(workspace => ({ ...workspace,
      goal: metadata.input.tasks?.find(task => task.id === workspace.id)?.goal })) }),
  'accept-write': metadata => ({ mode: 'accept-write', ...diffApproval(metadata), evidence: metadata.evidence }),
  'apply-handoff': metadata => ({ mode: 'apply-handoff', ...diffApproval(metadata), digest: metadata.digest,
    handoffDigest: metadata.handoffDigest, jobID: metadata.jobID, warning: metadata.warning }),
};
function project<Key extends Mode>(mode: Key, metadata: Extract<Metadata, { mode: Key }>) {
  return projections[mode](metadata);
}

/** One host-parsed permission view; the browser does not interpret arbitrary metadata as approval scope. */
export function operatorWriteApprovalOf(permission: { permission: string; metadata: unknown }): OperatorWriteApproval | undefined {
  if (permission.permission !== OPERATOR_WRITE_PERMISSION) return;
  const metadata = Metadata.safeParse(permission.metadata);
  if (!metadata.success) return;
  return project(metadata.data.mode, metadata.data);
}
