import { createHash } from 'node:crypto';
import { z } from 'zod';

export const OPERATOR_CHECK_LIMITS = { checksPerTask: 4, pathsPerCheck: 8, attemptsPerCheck: 3,
  outputChars: 24_000, pathChars: 2_048 };
const Identifier = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const OperatorCheckPath = z.string().min(1).max(OPERATOR_CHECK_LIMITS.pathChars).refine(path =>
  !path.startsWith('/') && !path.startsWith('-') && !/[\\\u0000-\u001f\u007f*?\[\]{}()]/.test(path)
  && path.split('/').every(part => part !== '' && !['.', '..', '.git'].includes(part)), 'operator_check_path_invalid');
export const OperatorCheckCommand = z.array(z.string()).min(3).max(OPERATOR_CHECK_LIMITS.pathsPerCheck + 2)
  .superRefine((command, context) => {
    if (command[0] !== 'node' || command[1] !== '--test'
      || command.slice(2).some(path => !OperatorCheckPath.safeParse(path).success)) {
      context.addIssue({ code: 'custom', message: 'operator_check_command_invalid' });
    }
  });
export const OperatorTaskCheck = z.object({ id: Identifier, command: OperatorCheckCommand });
export type OperatorTaskCheck = z.infer<typeof OperatorTaskCheck>;
export const OperatorCheckRecord = z.object({
  id: Identifier, checkID: Identifier, command: OperatorCheckCommand,
  callID: z.string().min(1), messageID: Identifier, artifactDigest: Hash,
  status: z.enum(['prepared', 'completed']), startedAt: z.string().min(1),
  completedAt: z.string().min(1).optional(), exitCode: z.number().int().optional(),
  output: z.string().max(OPERATOR_CHECK_LIMITS.outputChars).optional(), outputTruncated: z.boolean().optional(),
  digest: Hash.optional(),
}).superRefine((record, context) => {
  if (record.status === 'completed' && (record.completedAt === undefined || record.exitCode === undefined
    || record.output === undefined || record.digest === undefined)) {
    context.addIssue({ code: 'custom', message: 'operator_check_completion_incomplete' });
  }
});
export type OperatorCheckRecord = z.infer<typeof OperatorCheckRecord>;

/** Host receipt integrity; a successful model statement is never a check result. */
export function operatorCheckRecordDigest(record: OperatorCheckRecord) {
  return createHash('sha256').update(JSON.stringify({ id: record.id, checkID: record.checkID, command: record.command,
    callID: record.callID, messageID: record.messageID, artifactDigest: record.artifactDigest, status: record.status,
    startedAt: record.startedAt, completedAt: record.completedAt, exitCode: record.exitCode, output: record.output,
    outputTruncated: record.outputTruncated })).digest('hex');
}
