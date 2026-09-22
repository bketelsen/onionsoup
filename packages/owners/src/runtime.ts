import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isIncusOwner, isRepositoryOwner, loadDeclarations, requireOwner, type Declarations, type IncusOwner, type OwnerDeclaration, type RepositoryOwner } from './declarations.ts';
import { familyOf } from './families.ts';
import { cliIncus, ManagedInstances, type IncusClient } from './incus.ts';
import { Ledger, type HireRecord, type WorkItem } from './ledger.ts';
import { Notebook } from './notebook.ts';
import { Requests } from './requests.ts';
import { Freelancers, HireError, type HireRequest } from './opencode.ts';

export const RUNTIME_LIMITS = { findingChars: 2_000 };

export interface RuntimePaths {
  declarations: string;
  state: string;
}

/** Everything a command needs: declarations, the ledger, notebooks and the freelancer pool. */
export class Runtime {
  readonly ledger: Ledger;
  readonly notebooksRoot: string;
  readonly worktreesRoot: string;
  readonly managed: ManagedInstances;
  readonly requests: Requests;
  /** Replaceable so tests never touch real incus. */
  incus: IncusClient = cliIncus;
  private pool: Freelancers | undefined;

  private constructor(readonly declarations: Declarations, readonly stateDirectory: string) {
    this.ledger = new Ledger(join(stateDirectory, 'items'));
    this.notebooksRoot = join(stateDirectory, 'notebooks');
    this.worktreesRoot = join(stateDirectory, 'worktrees');
    this.managed = new ManagedInstances(join(stateDirectory, 'managed'));
    this.requests = new Requests(join(stateDirectory, 'requests'));
  }

  static async open(paths: RuntimePaths) {
    const state = resolve(paths.state);
    await mkdir(state, { recursive: true });
    return new Runtime(await loadDeclarations(paths.declarations), state);
  }

  /** One runtime at a time owns the ledger; a stale lock means the last one died mid-work. */
  async lock() {
    const lockPath = join(this.stateDirectory, 'runtime.lock');
    try {
      await mkdir(lockPath);
    } catch {
      throw new Error(`runtime_locked: another runtime holds ${lockPath}; remove it if none is running`);
    }
    return async () => rm(lockPath, { recursive: true, force: true });
  }

  owner(ownerId: string): OwnerDeclaration {
    const owner = requireOwner(this.declarations, ownerId);
    return { ...owner, workspace: resolve(this.declarations.root, owner.workspace) };
  }

  repositoryOwner(ownerId: string): RepositoryOwner {
    const owner = this.owner(ownerId);
    if (!isRepositoryOwner(owner)) throw new Error(`not_a_repository_owner: ${ownerId}`);
    return owner;
  }

  incusOwner(ownerId: string): IncusOwner {
    const owner = this.owner(ownerId);
    if (!isIncusOwner(owner)) throw new Error(`not_an_incus_owner: ${ownerId}`);
    return owner;
  }

  notebook(ownerId: string) {
    return new Notebook(this.notebooksRoot, ownerId);
  }

  async text(relativePath: string) {
    return readFile(resolve(this.declarations.root, relativePath), 'utf8');
  }

  family(model: string) {
    return familyOf(this.declarations.families, model);
  }

  async freelancers() {
    this.pool ??= await Freelancers.start();
    return this.pool;
  }

  close() {
    this.pool?.close();
  }

  /**
   * Hire with a findings file, and journal whatever the hire wrote there, even when it fails or dies.
   * A crashed session once found a real bug and took it to the grave; this is the fix.
   */
  async hire<T>(ownerId: string, request: HireRequest<T>, workItem?: string) {
    const pool = await this.freelancers();
    const notesDirectory = join(this.stateDirectory, 'notes', `${Date.now()}-${randomUUID().slice(0, 8)}`);
    await mkdir(notesDirectory, { recursive: true });
    const notesFile = join(notesDirectory, 'findings.md');
    await writeFile(notesFile, '');
    try {
      return await pool.hire({ ...request, notesFile });
    } finally {
      await this.ingestFindings(ownerId, notesFile, request.title, workItem);
    }
  }

  private async ingestFindings(ownerId: string, notesFile: string, title: string, workItem?: string) {
    const findings = (await readFile(notesFile, 'utf8').catch(() => '')).split('\n').map(line => line.trim()).filter(Boolean);
    if (!findings.length) return;
    const notebook = this.notebook(ownerId);
    for (const finding of findings) await notebook.journal({ kind: 'finding', workItem, stage: title, note: finding.slice(0, RUNTIME_LIMITS.findingChars) });
    await notebook.commit(`findings from ${title}`);
  }

  /** Hire, record the hire on the work item, and rethrow failures after recording them. */
  async hireFor<T>(item: WorkItem, stage: string, craft: string, request: HireRequest<T>) {
    const startedAt = new Date().toISOString();
    const base = { stage, craft, model: request.model, family: this.family(request.model) };
    try {
      const result = await this.hire(item.owner, request, item.id);
      const record: HireRecord = { ...base, sessionID: result.sessionID, startedAt, finishedAt: result.finishedAt, cost: result.cost, outcome: 'delivered' };
      item.hires.push(record);
      return result.value;
    } catch (error) {
      const sessionID = error instanceof HireError ? error.sessionID : 'none';
      const message = error instanceof Error ? error.message : String(error);
      item.hires.push({ ...base, sessionID, startedAt, finishedAt: new Date().toISOString(), cost: 0, outcome: 'failed', error: message });
      throw error;
    }
  }
}
