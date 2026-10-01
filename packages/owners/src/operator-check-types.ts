import { createHash } from 'node:crypto';
import { z } from 'zod';

export const OPERATOR_CHECK_LIMITS = { checksPerTask: 4, pathsPerCheck: 8, attemptsPerCheck: 3,
  outputChars: 24_000, pathChars: 2_048 };
const Identifier = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const OperatorCheckPath = z.string().min(1).max(OPERATOR_CHECK_LIMITS.pathChars).refine(path =>
  !path.startsWith('/') && !path.startsWith('-') && !/[\\\u0000-\u001f\u007f*?\[\]{}()]/.test(path)
  && path.split('/').every(part => part !== '' && !['.', '..', '.git'].includes(part)), 'operator_check_path_invalid');
export const OperatorGoPackage = z.string().min(1).max(OPERATOR_CHECK_LIMITS.pathChars).refine(path => {
  if (path === './...') return true;
  if (!path.startsWith('./')) return false;
  const local = path.slice(2).replace(/\/\.\.\.$/, '');
  return OperatorCheckPath.safeParse(local).success && !local.split('/').some(part => part.includes('...'));
}, 'operator_check_package_invalid');
export type OperatorCheckKind = 'node-test' | 'go-test' | 'go-vet';
const commandValidators: Record<string, (command: string[]) => boolean> = {
  'node --test': command => command.slice(2).every(path => OperatorCheckPath.safeParse(path).success),
  'go test': command => command.slice(2).every(path => OperatorGoPackage.safeParse(path).success),
  'go vet': command => command.slice(2).every(path => OperatorGoPackage.safeParse(path).success),
};
const commandKinds: Record<string, OperatorCheckKind> = {
  'node --test': 'node-test', 'go test': 'go-test', 'go vet': 'go-vet',
};
/** Call only after command parsing at the host boundary. */
export function operatorCheckKind(command: string[]): OperatorCheckKind {
  const kind = commandKinds[command.slice(0, 2).join(' ')];
  if (!kind) throw new Error('operator_check_command_invalid');
  return kind;
}
export const OperatorCheckCommand = z.array(z.string()).min(3).max(OPERATOR_CHECK_LIMITS.pathsPerCheck + 2)
  .superRefine((command, context) => {
    if (!commandValidators[command.slice(0, 2).join(' ')]?.(command)) {
      context.addIssue({ code: 'custom', message: 'operator_check_command_invalid' });
    }
  });
function validateGoSourcePaths(command: string[], paths: Set<string>) {
  if (!paths.has('go.mod')) throw new Error('operator_check_go_module_missing');
  for (const target of command.slice(2)) {
    const recursive = target.endsWith('/...');
    const prefix = target === './...' ? '' : `${target.slice(2).replace(/\/\.\.\.$/, '')}/`;
    if (![...paths].some(path => path.startsWith(prefix) && path.endsWith('.go')
      && (recursive || !path.slice(prefix.length).includes('/')))) {
      throw new Error('operator_check_go_package_missing');
    }
  }
}
const sourceValidators: Record<OperatorCheckKind, (command: string[], paths: Set<string>) => void> = {
  'node-test': (command, paths) => {
    if (command.slice(2).some(path => !paths.has(path))) throw new Error('operator_check_test_missing');
  },
  'go-test': validateGoSourcePaths,
  'go-vet': validateGoSourcePaths,
};
/** Shared scope proof for baseline authorization and the exact source snapshot before execution. */
export function validateOperatorCheckSourcePaths(command: string[], paths: Set<string>) {
  sourceValidators[operatorCheckKind(command)](command, paths);
}
export const OperatorTaskCheck = z.object({ id: Identifier, command: OperatorCheckCommand });
export type OperatorTaskCheck = z.infer<typeof OperatorTaskCheck>;
export const OperatorCheckRuntimeEvidence = z.object({ kind: z.literal('go'),
  version: z.string().regex(/^go[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:[a-zA-Z0-9.-]*)$/).max(128),
  binarySha256: Hash });
export type OperatorCheckRuntimeEvidence = z.infer<typeof OperatorCheckRuntimeEvidence>;
export const OperatorCheckRecord = z.object({
  id: Identifier, checkID: Identifier, command: OperatorCheckCommand,
  callID: z.string().min(1), messageID: Identifier, artifactDigest: Hash,
  status: z.enum(['prepared', 'completed']), startedAt: z.string().min(1),
  completedAt: z.string().min(1).optional(), exitCode: z.number().int().optional(),
  output: z.string().max(OPERATOR_CHECK_LIMITS.outputChars).optional(), outputTruncated: z.boolean().optional(),
  runtime: OperatorCheckRuntimeEvidence.optional(),
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
    outputTruncated: record.outputTruncated, runtime: record.runtime })).digest('hex');
}
