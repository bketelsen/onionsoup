import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { withRecordLock } from './record-lock.ts';
import { OperatorHandoffArtifact } from './operator-handoff-types.ts';
import { operatorHandoffArtifactDigest } from './operator-handoff-artifact.ts';
import { OperatorCheckRecord, operatorCheckRecordDigest } from './operator-check-types.ts';

export const OperatorHandoffRecord = z.object({ artifact: OperatorHandoffArtifact,
  jobDigest: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string().min(1), checks: z.array(OperatorCheckRecord) }).superRefine((record, context) => {
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
  if (invalid) context.addIssue({ code: 'custom', message: 'operator_handoff_record_invalid' });
});
export type OperatorHandoffRecord = z.infer<typeof OperatorHandoffRecord>;
const Ledger = z.object({ version: z.literal(1), records: z.array(OperatorHandoffRecord) });
type Ledger = z.infer<typeof Ledger>;

export async function writeHandoffFile(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

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
