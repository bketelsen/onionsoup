import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ImplementationReport, OwnerAnswers, Plan, ProposedWork, Verdict } from './artifacts.ts';

export const HireRecord = z.object({
  stage: z.string(),
  craft: z.string(),
  model: z.string(),
  family: z.string(),
  sessionID: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  cost: z.number(),
  outcome: z.enum(['delivered', 'failed']),
  error: z.string().optional(),
});
export type HireRecord = z.infer<typeof HireRecord>;

export const Verification = z.object({
  command: z.string(),
  exitCode: z.number(),
  output: z.string(),
});
export type Verification = z.infer<typeof Verification>;

export const WorkStatus = z.enum([
  'proposed',
  'planning',
  'awaiting-plan-approval',
  'implementing',
  'reviewing',
  'landing',
  'landed',
  'failed',
  'interrupted',
]);
export type WorkStatus = z.infer<typeof WorkStatus>;

export const WorkItem = z.object({
  id: z.string(),
  owner: z.string(),
  workflow: z.string(),
  proposal: ProposedWork,
  status: WorkStatus,
  reason: z.string().optional(),
  plan: Plan.optional(),
  ownerAnswers: OwnerAnswers.optional(),
  planApproval: z.object({ by: z.string(), at: z.string(), note: z.string().optional() }).optional(),
  implementations: z.array(z.object({ report: ImplementationReport, diffStat: z.string(), verification: z.array(Verification) })).default([]),
  verdicts: z.array(Verdict).default([]),
  replans: z.number().default(0),
  worktree: z.string().optional(),
  branch: z.string().optional(),
  landedCommit: z.string().optional(),
  hires: z.array(HireRecord).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkItem = z.infer<typeof WorkItem>;

export class Ledger {
  constructor(readonly directory: string) {}

  async create(owner: string, workflow: string, proposal: ProposedWork) {
    const now = new Date().toISOString();
    const item: WorkItem = WorkItem.parse({
      id: `w-${now.slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 6)}`,
      owner,
      workflow,
      proposal,
      status: 'proposed',
      createdAt: now,
      updatedAt: now,
    });
    await this.save(item);
    return item;
  }

  async get(id: string) {
    return WorkItem.parse(JSON.parse(await readFile(this.path(id), 'utf8')));
  }

  async list() {
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory)).filter(name => name.endsWith('.json'));
    const items = await Promise.all(names.map(name => this.get(name.slice(0, -'.json'.length))));
    return items.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async save(item: WorkItem) {
    await mkdir(this.directory, { recursive: true });
    const updated = { ...item, updatedAt: new Date().toISOString() };
    const temporary = `${this.path(item.id)}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, this.path(item.id));
    return updated;
  }

  /** Work left mid-stage by a crashed or stopped runtime is marked, never replayed. */
  async markInterrupted() {
    const active: WorkStatus[] = ['planning', 'implementing', 'reviewing', 'landing'];
    const stranded = (await this.list()).filter(item => active.includes(item.status));
    for (const item of stranded) {
      await this.save({ ...item, status: 'interrupted', reason: `runtime stopped while ${item.status}` });
    }
    return stranded.length;
  }

  private path(id: string) {
    return join(this.directory, `${id}.json`);
  }
}
