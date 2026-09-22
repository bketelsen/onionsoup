import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadDeclarations, requireOwner, type Declarations, type OwnerDeclaration } from './declarations.ts';
import { familyOf } from './families.ts';
import { Ledger, type HireRecord, type WorkItem } from './ledger.ts';
import { Notebook } from './notebook.ts';
import { Freelancers, HireError, type HireRequest } from './opencode.ts';

export interface RuntimePaths {
  declarations: string;
  state: string;
}

/** Everything a command needs: declarations, the ledger, notebooks and the freelancer pool. */
export class Runtime {
  readonly ledger: Ledger;
  readonly notebooksRoot: string;
  readonly worktreesRoot: string;
  private pool: Freelancers | undefined;

  private constructor(readonly declarations: Declarations, readonly stateDirectory: string) {
    this.ledger = new Ledger(join(stateDirectory, 'items'));
    this.notebooksRoot = join(stateDirectory, 'notebooks');
    this.worktreesRoot = join(stateDirectory, 'worktrees');
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
    return { ...owner, checkout: resolve(this.declarations.root, owner.checkout) };
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

  /** Hire, record the hire on the work item, and rethrow failures after recording them. */
  async hireFor<T>(item: WorkItem, stage: string, craft: string, request: HireRequest<T>) {
    const pool = await this.freelancers();
    const startedAt = new Date().toISOString();
    const base = { stage, craft, model: request.model, family: this.family(request.model) };
    try {
      const result = await pool.hire(request);
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
