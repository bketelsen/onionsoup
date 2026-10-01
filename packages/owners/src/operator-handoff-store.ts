import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeHandoffFile } from './operator-handoff-file.ts';
export { writeHandoffFile } from './operator-handoff-file.ts';
import { OperatorHandoffExecutionBinding, OperatorHandoffResolution, operatorHandoffPreparedDigest, originalHandoffPrepared } from './operator-handoff-execution.ts';
import { withRecordLock } from './record-lock.ts';
import { OperatorHandoffArtifact } from './operator-handoff-types.ts';
import { operatorHandoffArtifactDigest } from './operator-handoff-artifact.ts';
import { OperatorCheckRecord, operatorCheckRecordDigest } from './operator-check-types.ts';

export const OperatorHandoffRecord = z.object({ artifact: OperatorHandoffArtifact,
  jobDigest: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string().min(1), checks: z.array(OperatorCheckRecord),
  executions: z.array(OperatorHandoffExecutionBinding).optional(), resolutions: z.array(OperatorHandoffResolution).optional() }).superRefine((record, context) => {
  const ids = new Set<string>();
  const invalid = record.artifact.digest !== operatorHandoffArtifactDigest(record.artifact)
    || record.checks.some(receipt => {
      const check = record.artifact.checks.find(candidate => candidate.id === receipt.checkID);
      const duplicate = ids.has(receipt.checkID);
      ids.add(receipt.checkID);
      return duplicate || !check || JSON.stringify(check.command) !== JSON.stringify(receipt.command)
        || receipt.artifactDigest !== record.artifact.digest
        || (receipt.status === 'completed' && receipt.digest !== operatorCheckRecordDigest(receipt));
    });
  const executions = record.executions ?? [];
  const resolutions = record.resolutions ?? [];
  const invalidExecution = new Set(executions.map(entry => entry.receiptID)).size !== executions.length
    || executions.some(entry => {
      const receipt = record.checks.find(check => check.id === entry.receiptID);
      return !receipt || receipt.callID !== `handoff_${entry.token}` || entry.receiptDigest !== operatorHandoffPreparedDigest(receipt)
        || entry.artifactDigest !== record.artifact.digest || entry.admission.kind !== 'plugin:operator-handoff';
    });
  const invalidResolution = new Set(resolutions.map(entry => entry.receiptID)).size !== resolutions.length
    || resolutions.some(entry => {
      const receipt = record.checks.find(check => check.id === entry.receiptID);
      const execution = executions.find(candidate => candidate.receiptID === entry.receiptID);
      if (!receipt || !execution
        || JSON.stringify(entry.prepared) !== JSON.stringify(originalHandoffPrepared(receipt))) return true;
      if (entry.kind === 'completed') return !entry.completed || entry.completed.status !== 'completed'
        || operatorHandoffPreparedDigest(entry.completed) !== execution.receiptDigest
        || entry.completed.digest !== operatorCheckRecordDigest(entry.completed)
        || (receipt.status === 'completed' && JSON.stringify(receipt) !== JSON.stringify(entry.completed));
      return receipt.status !== 'prepared' || Boolean(entry.completed) || !entry.proof || entry.proof.sessionID !== record.artifact.origin.sessionID
        || entry.inspection?.state !== 'stopped';
    });
  if (invalid || invalidExecution || invalidResolution) context.addIssue({ code: 'custom', message: 'operator_handoff_record_invalid' });
});
export type OperatorHandoffRecord = z.infer<typeof OperatorHandoffRecord>;
const Ledger = z.object({ version: z.literal(1), records: z.array(OperatorHandoffRecord) });
type Ledger = z.infer<typeof Ledger>;


export class OperatorHandoffStore {
  readonly path: string;
  constructor(readonly home: string) { this.path = join(home, 'operator-handoffs', 'records.json'); }

  async read(): Promise<Ledger> {
    try { return Ledger.parse(JSON.parse(await readFile(this.path, 'utf8'))); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] };
      throw error;
    }
  }

  async transaction<T>(action: (ledger: Ledger, save: () => Promise<void>) => Promise<T>) {
    return withRecordLock(`${this.path}.lock`, async () => {
      const ledger = await this.read();
      return action(ledger, () => writeHandoffFile(this.path, JSON.stringify(Ledger.parse(ledger), null, 2)));
    });
  }
}
