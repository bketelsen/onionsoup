import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isRepositoryOwner, isTruenasOwner, loadDeclarations, ownsRepositories, repositoryNames, repositoryShortName, requireOwner, type Declarations, type IncusOwner, type OwnerDeclaration, type RepositoryOwner, type ResolvedOwner, type TruenasOwner } from './declarations.ts';
import { familyOf } from './families.ts';
import { cliIncus, ManagedInstances, type IncusClient } from './incus.ts';
import { Ledger, type HireRecord, type WorkItem } from './ledger.ts';
import { ssh, withTruenas } from './truenas.ts';
import { Notebook } from './notebook.ts';
import { Requests } from './requests.ts';
import { Initiatives } from './initiatives.ts';
import { Reminders } from './reminders.ts';
import { Freelancers, HireError, sandboxedHire, type ConnectHire, type HireRequest } from './opencode.ts';
import { ProviderHealthStore, providerOf, recordProviderFailure, recordProviderSuccess, type ProviderError } from './provider-health.ts';

export const RUNTIME_LIMITS = { findingChars: 2_000 };

/** What provider health reads from a failed hire: the model call's own error when there was one. */
function hireFailure(error: unknown): ProviderError {
  if (error instanceof HireError && error.providerError) return error.providerError;
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { message: String(error) };
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface RuntimePaths {
  declarations: string;
  state: string;
}

/** Everything a command needs: declarations, the ledger, notebooks and the freelancer pool. */
export class Runtime {
  readonly ledger: Ledger;
  readonly notebooksRoot: string;
  readonly worktreesRoot: string;
  readonly desksRoot: string;
  /** One worktree per approved plan, at `<plansRoot>/<owner>/<item>`, so parallel plans never share files. */
  readonly plansRoot: string;
  /** Owner-scoped tools (e.g. the mkdocs venv), referenced as {tools} in declarations. */
  readonly toolsDirectory: string;
  readonly managed: ManagedInstances;
  readonly requests: Requests;
  readonly initiatives: Initiatives;
  readonly reminders: Reminders;
  readonly providerHealth: ProviderHealthStore;
  /** Replaceable so tests script a hire's opencode instead of starting a sandbox. */
  connectHire: ConnectHire = sandboxedHire;
  /** Replaceable so tests never touch real incus. */
  incus: IncusClient = cliIncus;
  /** Replaceable transport so request tests never touch a real NAS. */
  truenas = withTruenas;
  truenasSsh = ssh;
  private pool: Freelancers | undefined;

  private constructor(public declarations: Declarations, readonly stateDirectory: string) {
    this.ledger = new Ledger(join(stateDirectory, 'items'));
    this.notebooksRoot = join(stateDirectory, 'notebooks');
    this.worktreesRoot = join(stateDirectory, 'worktrees');
    this.desksRoot = join(stateDirectory, '..', 'desks');
    this.plansRoot = join(stateDirectory, '..', 'plans');
    this.toolsDirectory = join(stateDirectory, '..', 'tools');
    this.managed = new ManagedInstances(join(stateDirectory, 'managed'));
    this.requests = new Requests(join(stateDirectory, 'requests'));
    this.initiatives = new Initiatives(join(stateDirectory, 'initiatives'));
    this.reminders = new Reminders(join(stateDirectory, 'reminders'));
    this.providerHealth = new ProviderHealthStore(join(stateDirectory, 'provider-health'));
  }

  static async open(paths: RuntimePaths) {
    const state = resolve(paths.state);
    await mkdir(state, { recursive: true });
    return new Runtime(await loadDeclarations(paths.declarations), state);
  }

  /** Re-read the configuration, so owners created or changed since start take effect without a restart. */
  async reloadDeclarations() {
    this.declarations = await loadDeclarations(this.declarations.root);
  }

  /** One runtime at a time owns the ledger. The lock records who holds it, so "busy" can say who. */
  async lock() {
    const lockPath = join(this.stateDirectory, 'runtime.lock');
    try {
      await mkdir(lockPath);
    } catch {
      if (!(await this.lockIsStale())) throw new Error(`runtime_locked: ${await this.lockHolder()}`);
      // The holder died (SIGKILL, crash); its unfinished work is marked interrupted by whoever runs next.
      await rm(lockPath, { recursive: true, force: true });
      await mkdir(lockPath);
    }
    const holder = { pid: process.pid, command: process.argv.slice(2).join(' '), startedAt: new Date().toISOString() };
    await writeFile(join(lockPath, 'holder.json'), JSON.stringify(holder) + '\n');
    return async () => rm(lockPath, { recursive: true, force: true });
  }

  private async lockIsStale() {
    const text = await readFile(join(this.stateDirectory, 'runtime.lock', 'holder.json'), 'utf8').catch(() => '');
    return Boolean(text) && !isAlive((JSON.parse(text) as { pid: number }).pid);
  }

  /** Who holds the lock, and whether that process is still alive. */
  async lockHolder() {
    const lockPath = join(this.stateDirectory, 'runtime.lock');
    const text = await readFile(join(lockPath, 'holder.json'), 'utf8').catch(() => '');
    if (!text) return `held by an unknown process (${lockPath})`;
    const holder = JSON.parse(text) as { pid: number; command: string; startedAt: string };
    const alive = isAlive(holder.pid);
    const since = `since ${holder.startedAt}`;
    return alive
      ? `held by pid ${holder.pid} (\`owners ${holder.command}\`) ${since}`
      : `STALE: pid ${holder.pid} (\`owners ${holder.command}\`) is gone; remove ${lockPath} and run \`owners recover\``;
  }

  owner(ownerId: string): ResolvedOwner {
    const owner = requireOwner(this.declarations, ownerId);
    const fallback = join(this.stateDirectory, '..', ownsRepositories(owner) ? 'checkouts' : 'evidence', owner.id);
    return { ...owner, workspace: owner.workspace ? resolve(this.declarations.root, owner.workspace) : fallback };
  }

  /**
   * An owner as the owner of one repository. For a group, name the repository: the view has that repository as
   * its domain, its checkout under the group's workspace and its own desk. A single-repository owner is itself.
   */
  repositoryOwner(ownerId: string, repository?: string): RepositoryOwner {
    const owner = this.owner(ownerId);
    if (isRepositoryOwner(owner)) {
      if (repository && repository !== owner.domain.name) throw new Error(`not_your_repository: ${ownerId} owns ${owner.domain.name}, not ${repository}`);
      return owner;
    }
    if (owner.domain.kind !== 'repository-group') throw new Error(`not_a_repository_owner: ${ownerId}`);
    const names = owner.domain.repositories.map(member => member.name);
    if (!repository) throw new Error(`which_repository: ${ownerId} owns ${names.join(', ')}; name one`);
    const member = owner.domain.repositories.find(candidate => candidate.name === repository);
    if (!member) throw new Error(`not_your_repository: ${repository} is not one of ${ownerId}'s repositories (${names.join(', ')})`);
    const short = repositoryShortName(member.name);
    return { ...owner, domain: { kind: 'git-repository', ...member }, workspace: join(owner.workspace, short), desk: join(this.desksRoot, owner.id, short) };
  }

  /** Every repository an owner owns, as single-repository views (empty for owners without repositories). */
  repositoryViews(ownerId: string): RepositoryOwner[] {
    return repositoryNames(this.owner(ownerId)).map(name => this.repositoryOwner(ownerId, name));
  }

  /** The repository a work item is in. */
  repositoryFor(item: WorkItem): RepositoryOwner {
    return this.repositoryOwner(item.owner, item.proposal.repository);
  }

  /**
   * An incus view of an owner: its incus configuration as the domain, and the directory host code writes
   * its read-only snapshot into as the workspace. Pure incus owners are already this shape.
   */
  incusOwner(ownerId: string): IncusOwner {
    const owner = this.owner(ownerId);
    if (owner.domain.kind === 'incus') return owner as IncusOwner;
    if (!owner.incus) throw new Error(`not_an_incus_owner: ${ownerId}`);
    return { ...owner, domain: { kind: 'incus', ...owner.incus }, workspace: this.evidenceDirectory(ownerId) };
  }

  /** Where host code writes an owner's read-only snapshot: its workspace, unless the workspace is a repository. */
  evidenceDirectory(ownerId: string) {
    const owner = this.owner(ownerId);
    return ownsRepositories(owner) ? join(this.stateDirectory, '..', 'evidence', ownerId) : owner.workspace;
  }

  truenasOwner(ownerId: string): TruenasOwner {
    const owner = this.owner(ownerId);
    if (!isTruenasOwner(owner)) throw new Error(`not_a_truenas_owner: ${ownerId}`);
    return owner;
  }

  notebook(ownerId: string) {
    return new Notebook(this.notebooksRoot, ownerId, () => this.text(`charters/${ownerId}.md`));
  }

  async text(relativePath: string) {
    return readFile(resolve(this.declarations.root, relativePath), 'utf8');
  }

  family(model: string) {
    return familyOf(this.declarations.families, model);
  }

  async freelancers() {
    this.pool ??= await Freelancers.start(() => this.declarations.providers, (request, providers) => this.connectHire(request, providers));
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
    const provider = providerOf(request.model);
    try {
      const result = await pool.hire({ ...request, notesFile });
      await recordProviderSuccess(this, provider);
      return result;
    } catch (error) {
      await recordProviderFailure(this, provider, { kind: 'hire', what: request.title }, hireFailure(error));
      throw error;
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
