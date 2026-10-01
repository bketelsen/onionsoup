import { z } from 'zod';
import { OperatorWriteMutation, OperatorWriteSnapshot, operatorWriteSha256 } from './operator-write-workspace.ts';

export const OPERATOR_APPLICATION_WRITER_LIMITS = { fileBytes: 256 * 1024, stagingPrefix: '.onionsoup-application-' };
export const OperatorApplicationFileIdentity = OperatorWriteSnapshot.shape.files.element;
export type OperatorApplicationFileIdentity = z.infer<typeof OperatorApplicationFileIdentity>;
const Intent = z.object({ version: z.literal(1), directory: z.string().min(1), mutation: OperatorWriteMutation,
  parents: OperatorWriteSnapshot.shape.parents, before: z.union([z.literal('absent'), OperatorApplicationFileIdentity]),
  stage: OperatorApplicationFileIdentity, digest: z.string().regex(/^[a-f0-9]{64}$/) });
export function operatorApplicationIntentDigest(value: z.infer<typeof Intent>) {
  const { digest: _digest, ...payload } = Intent.parse(value);
  return operatorWriteSha256(JSON.stringify(payload));
}
export const OperatorApplicationFileIntent = Intent.superRefine((intent, context) => {
  if (intent.digest !== operatorApplicationIntentDigest(intent) || intent.stage.kind !== 'file'
    || !intent.stage.birthtimeNs || intent.stage.sha256 !== intent.mutation.afterSha256
    || intent.stage.links !== 1 || intent.stage.bytes > OPERATOR_APPLICATION_WRITER_LIMITS.fileBytes
    || (intent.before === 'absent') !== (intent.mutation.beforeSha256 === 'absent')
    || (intent.before !== 'absent' && (intent.before.kind !== 'file' || !intent.before.birthtimeNs || intent.before.path !== intent.mutation.path
      || intent.before.sha256 !== intent.mutation.beforeSha256 || intent.before.links !== 1))) {
    context.addIssue({ code: 'custom', message: 'operator_application_intent_invalid' });
  }
});
export type OperatorApplicationFileIntent = z.infer<typeof OperatorApplicationFileIntent>;
export const OperatorApplicationFileObservation = z.object({ state: z.enum(['before', 'after', 'partial', 'foreign', 'unavailable']),
  reason: z.string(), target: OperatorApplicationFileIdentity.optional(), stage: OperatorApplicationFileIdentity.optional() });
export type OperatorApplicationFileObservation = z.infer<typeof OperatorApplicationFileObservation>;
