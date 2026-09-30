import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { withRecordLock } from './record-lock.ts';
import {
  OperatorJob, OperatorJobInput, OperatorJobIntake, OperatorJobLedger, OperatorJobOrigin,
  OPERATOR_JOB_LIMITS, type OperatorJobEvent,
} from './operator-jobs-types.ts';

export function operatorJobDigest(job: OperatorJob) {
  return createHash('sha256').update(JSON.stringify({
    id: job.id, origin: job.origin, intake: job.intake, goal: job.goal, constraints: job.constraints,
    scope: job.scope, children: job.children,
  })).digest('hex');
}

export function operatorJobEvent(job: OperatorJob, kind: OperatorJobEvent['kind'], detail: string, childID?: string) {
  const at = new Date().toISOString();
  job.events.push({ id: `event_${randomUUID()}`, at, kind, detail, ...(childID ? { childID } : {}) });
  job.updatedAt = at;
  job.revision++;
}

function sameOrigin(left: OperatorJobOrigin, right: OperatorJobOrigin) {
  return left.operator === right.operator && left.sessionID === right.sessionID && left.directory === right.directory;
}

function validateDependencies(input: OperatorJobInput) {
  const ids = new Set(input.tasks.map(task => task.id));
  if (ids.size !== input.tasks.length) throw new Error('operator_job_duplicate_task');
  const resolved = new Set<string>();
  for (let pass = 0; pass < input.tasks.length; pass++) {
    for (const task of input.tasks) {
      if (task.dependsOn.every(id => resolved.has(id))) resolved.add(task.id);
    }
  }
  if (resolved.size !== ids.size) throw new Error('operator_job_invalid_dependencies');
}

/** Host-only provenance: callers obtain origin/intake from authenticated chat context, never model arguments. */
export class OperatorJobs {
  readonly path: string;
  constructor(readonly home: string, readonly workspace: string, readonly operator: string) {
    this.path = join(home, 'operator-jobs', 'jobs.json');
  }

  async canonicalDirectory(directory: string) {
    const root = await realpath(this.workspace);
    const canonical = await realpath(directory);
    const inside = relative(root, canonical);
    if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('operator_job_workspace_outside_scope');
    return canonical;
  }

  async origin(input: OperatorJobOrigin) {
    const origin = OperatorJobOrigin.parse(input);
    if (origin.operator !== this.operator) throw new Error('operator_job_operator_mismatch');
    return { ...origin, directory: await this.canonicalDirectory(origin.directory) };
  }

  async transaction<T>(action: (ledger: OperatorJobLedger, save: () => Promise<void>) => Promise<T>) {
    return withRecordLock(`${this.path}.lock`, async () => {
      const ledger = await this.read();
      const save = async () => {
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(temporary, JSON.stringify(OperatorJobLedger.parse(ledger), null, 2), { mode: 0o600 });
        await rename(temporary, this.path);
      };
      return action(ledger, save);
    });
  }

  private async read(): Promise<OperatorJobLedger> {
    try {
      return OperatorJobLedger.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, jobs: [] };
      throw error;
    }
  }

  async list(originInput: OperatorJobOrigin) {
    const origin = await this.origin(originInput);
    return (await this.snapshot()).filter(job => sameOrigin(job.origin, origin));
  }

  async get(originInput: OperatorJobOrigin, id: string) {
    const origin = await this.origin(originInput);
    return this.bound({ version: 1, jobs: await this.snapshot() }, origin, id);
  }

  /** Atomic-file snapshot does not wait for a scheduler's bounded runtime metadata calls. */
  async snapshot() {
    return (await this.read()).jobs.filter(job => job.origin.operator === this.operator);
  }

  bound(ledger: OperatorJobLedger, origin: OperatorJobOrigin, id: string) {
    const job = ledger.jobs.find(candidate => candidate.id === id);
    if (!job || !sameOrigin(job.origin, origin)) throw new Error('operator_job_origin_mismatch');
    return job;
  }

  async create(originInput: OperatorJobOrigin, intakeInput: OperatorJobIntake, inputValue: OperatorJobInput) {
    const origin = await this.origin(originInput);
    const intake = OperatorJobIntake.parse(intakeInput);
    const input = OperatorJobInput.parse(inputValue);
    validateDependencies(input);
    for (const task of input.tasks) task.directory = await this.canonicalDirectory(task.directory);
    return this.transaction(async (ledger, save) => {
      const existing = ledger.jobs.find(job => sameOrigin(job.origin, origin) && job.key === input.key);
      if (existing) {
        const previous = { goal: existing.goal, constraints: existing.constraints, tasks: existing.children.map(({ id, goal, directory, access, dependsOn }) => ({ id, goal, directory, access, dependsOn })) };
        if (JSON.stringify(previous) !== JSON.stringify({ goal: input.goal, constraints: input.constraints, tasks: input.tasks })
          || JSON.stringify(existing.intake) !== JSON.stringify(intake)) throw new Error('operator_job_idempotency_conflict');
        return existing;
      }
      const job = makeJob(origin, intake, input);
      ledger.jobs.push(job);
      await save();
      return job;
    });
  }

  async synthesize(originInput: OperatorJobOrigin, id: string, digest: string, evidenceIDs: string[], text: string) {
    const origin = await this.origin(originInput);
    return this.transaction(async (ledger, save) => {
      const job = this.bound(ledger, origin, id);
      if (job.synthesis) {
        if (job.synthesis.digest !== digest || job.synthesis.text !== text
          || JSON.stringify(job.synthesis.evidenceIDs) !== JSON.stringify(evidenceIDs)) throw new Error('operator_job_synthesis_conflict');
        return job;
      }
      if (job.status !== 'needs-synthesis' || operatorJobDigest(job) !== digest) throw new Error('operator_job_synthesis_stale');
      const expected = job.children.map(child => child.evidence!.messageID).sort();
      if (JSON.stringify([...evidenceIDs].sort()) !== JSON.stringify(expected)) throw new Error('operator_job_evidence_mismatch');
      if (!text.trim() || text.length > OPERATOR_JOB_LIMITS.textChars) throw new Error('operator_job_synthesis_invalid');
      job.synthesis = { digest, evidenceIDs, text, at: new Date().toISOString() };
      job.status = 'completed';
      operatorJobEvent(job, 'synthesized', 'Operator synthesis recorded against exact child transcript evidence; model conclusions are not independent verification.');
      await save();
      return job;
    });
  }
}

function makeJob(origin: OperatorJobOrigin, intake: OperatorJobIntake, input: OperatorJobInput): OperatorJob {
  const id = `job_${randomUUID()}`;
  const at = new Date().toISOString();
  const job: OperatorJob = {
    id, origin, intake, key: input.key, goal: input.goal, constraints: input.constraints, scope: 'read-only-investigation',
    createdAt: at, updatedAt: at, revision: 0, status: 'running', events: [],
    children: input.tasks.map(task => ({ ...task, title: `onionsoup-investigation:${id}:${task.id}:${randomUUID()}`, status: 'queued', attempts: [] })),
  };
  operatorJobEvent(job, 'created', 'Read-only investigations queued under the original human intake; no owner delegation or write authority.');
  return job;
}
