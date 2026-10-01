import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OperatorApplication } from './operator-application-types.ts';
import { writeHandoffFile } from './operator-handoff-file.ts';
import { withRecordLock } from './record-lock.ts';

export class OperatorApplicationStore {
  constructor(readonly home: string) {}
  path(jobID: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(jobID)) throw new Error('operator_application_id_invalid');
    return join(this.home, 'operator-applications', `${jobID}.json`);
  }
  async read(jobID: string): Promise<OperatorApplication | undefined> {
    try {
      const record = OperatorApplication.parse(JSON.parse(await readFile(this.path(jobID), 'utf8')));
      if (record.scope.artifact.jobID !== jobID) throw new Error('operator_application_job_mismatch');
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async transaction<T>(jobID: string, action: (record: OperatorApplication | undefined,
    save: (record: OperatorApplication) => Promise<void>) => Promise<T>) {
    return withRecordLock(`${this.path(jobID)}.lock`, async () => action(await this.read(jobID), async record => {
      const parsed = OperatorApplication.parse(record);
      if (parsed.scope.artifact.jobID !== jobID) throw new Error('operator_application_job_mismatch');
      await writeHandoffFile(this.path(jobID), JSON.stringify(parsed, null, 2));
    }));
  }
}
