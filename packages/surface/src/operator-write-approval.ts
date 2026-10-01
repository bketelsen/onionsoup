import { z } from 'zod';
import { OPERATOR_WRITE_PERMISSION, OperatorTaskCheck, OperatorCheckRecord } from '@onionsoup/owners';

const Workspace = z.object({ id: z.string(), directory: z.string(), head: z.string(), files: z.array(z.string()),
  createFiles: z.array(z.string()).default([]), checks: z.array(OperatorTaskCheck).default([]), goal: z.string().optional() });
const Common = z.object({ intake: z.string(), goal: z.string(), constraints: z.array(z.string()) });
export const OperatorWriteApproval = z.discriminatedUnion('mode', [
  Common.extend({ mode: z.literal('create-write'), workspaces: z.array(Workspace) }),
  Common.extend({ mode: z.literal('accept-write'), directory: z.string(), head: z.string(), diff: z.string(),
    files: z.array(z.string()), checks: z.array(OperatorCheckRecord).default([]), evidence: z.object({ sessionID: z.string(), messageID: z.string() }).optional() }),
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

/** One host-parsed permission view; the browser does not interpret arbitrary metadata as approval scope. */
export function operatorWriteApprovalOf(permission: { permission: string; metadata: unknown }): OperatorWriteApproval | undefined {
  if (permission.permission !== OPERATOR_WRITE_PERMISSION) return;
  const create = CreateMetadata.safeParse(permission.metadata);
  if (create.success) return { mode: 'create-write', intake: create.data.intake.text, goal: create.data.input.goal,
    constraints: create.data.input.constraints, workspaces: create.data.workspaces.map(workspace => ({ ...workspace,
      goal: create.data.input.tasks?.find(task => task.id === workspace.id)?.goal })) };
  const accept = AcceptMetadata.safeParse(permission.metadata);
  if (accept.success) return { mode: 'accept-write', intake: accept.data.originalIntake.text, goal: accept.data.goal,
    constraints: accept.data.constraints, directory: accept.data.directory, head: accept.data.artifact.head,
    diff: accept.data.artifact.diff, files: accept.data.artifact.files.map(file => file.path),
    checks: accept.data.checks, evidence: accept.data.evidence };
}
