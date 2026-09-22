import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { atomicJson, optionalJson, readJson } from '@onionsoup/runtime/storage';
import { RepositoryProfile, NodeRepositoryProfile } from '@onionsoup/implementation/project/repository-profile';
import { Runtime } from '@onionsoup/implementation/project/contracts';
import { ImplementationConfig } from './implementation.ts';

const execute = promisify(execFile);

export const RepositoryName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);

/** One repository the host may work on. Entries from the host config are fixed; onboarded ones persist in the registry file. */
export const RepositoryEntry = z.object({
  name: RepositoryName,
  checkout: z.string().min(1).optional(),
  implementation: ImplementationConfig.optional(),
  origin: z.enum(['config', 'registry']),
  onboardedAt: z.iso.datetime().optional(),
}).strict();
export type RepositoryEntry = z.infer<typeof RepositoryEntry>;

const RegistryFile = z.object({ schemaVersion: z.literal(1), repositories: z.array(RepositoryEntry).max(500) }).strict();

export type RegistryOptions = {
  /** Where onboarded checkouts, profiles and the registry file live. */
  directory: string;
  /** Repositories from the host configuration; they cannot be edited through the registry. */
  entries: Omit<RepositoryEntry, 'origin'>[];
  /** Pinned Node sandbox runtime shared by onboarded Node repositories; without it, onboarding registers reads only. */
  nodeRuntime?: string;
};

export class RepositoryRegistry {
  private readonly entries = new Map<string, RepositoryEntry>();
  private constructor(readonly options: RegistryOptions) {}

  /** A registry that only knows the configured entries and never persists. */
  static fixed(entries: RegistryOptions['entries']) {
    const registry = new RepositoryRegistry({ directory: '', entries });
    for (const entry of entries) registry.entries.set(entry.name, RepositoryEntry.parse({ ...entry, origin: 'config' }));
    return registry;
  }

  static async open(options: RegistryOptions) {
    const registry = new RepositoryRegistry(options);
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    for (const entry of options.entries) registry.entries.set(entry.name, RepositoryEntry.parse({ ...entry, origin: 'config' }));
    const saved = await optionalJson(registry.file);
    if (saved !== undefined) {
      for (const entry of RegistryFile.parse(saved).repositories) if (!registry.entries.has(entry.name)) registry.entries.set(entry.name, entry);
    }
    return registry;
  }

  private get file() { return join(this.options.directory, 'repositories.json'); }

  list(): RepositoryEntry[] { return [...this.entries.values()]; }
  names(): string[] { return [...this.entries.keys()]; }
  has(name: string) { return this.entries.has(name); }
  get(name: string) { return this.entries.get(name); }

  /** A schema for a repository input: an enum when there are repositories, so forms can offer a dropdown. */
  schema() {
    const names = this.names();
    return names.length ? z.enum(names as [string, ...string[]]) : RepositoryName.refine(() => false, 'No repositories are registered');
  }

  async save(entry: RepositoryEntry) {
    if (this.entries.get(entry.name)?.origin === 'config') throw new Error('repository_fixed_by_config');
    this.entries.set(entry.name, RepositoryEntry.parse({ ...entry, origin: 'registry' }));
    await atomicJson(this.file, RegistryFile.parse({ schemaVersion: 1, repositories: this.list().filter((e) => e.origin === 'registry') }));
    return this.entries.get(entry.name)!;
  }

  /** Directory for one repository's onboarded files. */
  home(name: string) { return join(this.options.directory, name.replace('/', '--')); }
}

const git = async (args: string[], cwd?: string) => (await execute('git', args, { cwd, timeout: 600000, maxBuffer: 16000000 })).stdout;

export type Detected = { profile: z.infer<typeof RepositoryProfile>; note: string } | { profile?: undefined; note: string };
export type NodeRuntime = Extract<z.infer<typeof Runtime>, { schemaVersion: 1 }>;

/**
 * Derive a repository profile from what the checkout contains. Node projects verify by their selected test files when
 * they have any, otherwise by their build script; other languages register for reads only.
 */
export async function detectProfile(checkout: string, name: string, repositoryId: number, baseBranch: string, nodeRuntime?: NodeRuntime): Promise<Detected> {
  const files = (await git(['ls-files', '-z'], checkout)).split('\0').filter(Boolean);
  const has = (path: string) => files.includes(path);
  if (!has('package.json') || !has('package-lock.json')) {
    return { note: has('go.mod') ? 'Go module: registered for reads; Go implementation needs an operator-pinned Go runtime.' : 'No package.json with package-lock.json: registered for reads only.' };
  }
  if (!nodeRuntime) return { note: 'Node project, but no Node sandbox runtime is configured on the host: registered for reads only.' };
  const manifest = JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8')) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  const nodeVersion = (await execute(nodeRuntime.nodePath, ['--version'], { timeout: 10000 })).stdout.trim();
  const testFiles = files.filter((path) => /\.test\.(?:ts|mjs|js)$/.test(path) && !path.includes('node_modules/')).slice(0, 50);
  const buildScript = manifest.scripts?.build?.trim();
  // The test harness runs tsc and the tsx loader from the project's own dependencies.
  const usesTests = testFiles.length > 0 && Boolean(declared.typescript) && Boolean(declared.tsx);
  let verification: z.infer<typeof NodeRepositoryProfile>['verification'];
  let note: string;
  if (usesTests) {
    verification = { required: ['node-typecheck', 'node-tests'], testFiles };
    note = `Node project verified by ${testFiles.length} test file(s) under tsc and node --test.`;
  } else if (buildScript) {
    const [bin, ...args] = buildScript.split(/\s+/);
    if (!/^[a-z0-9@._-]{1,80}$/.test(bin) || args.some((arg) => !/^[A-Za-z0-9_.=/-]{1,80}$/.test(arg))) return { note: `Node project, but its build script (${buildScript}) is not a plain package binary invocation: registered for reads only.` };
    verification = { required: ['node-build'], build: { bin, args } };
    note = `Node project verified by its build script: ${buildScript}.`;
  } else {
    return { note: 'Node project without test files or a build script: registered for reads only.' };
  }
  const profile = NodeRepositoryProfile.parse({
    schemaVersion: 1, id: `${name.replace('/', '-').toLowerCase().replace(/[^a-z0-9-]/g, '-')}-v1`, repository: name, repositoryId, baseBranch,
    execution: { adapter: 'node-typescript-v1', sandbox: 'offline-node-v1', toolchain: { version: nodeVersion, digest: nodeRuntime.nodeHash }, dependencies: 'public-locked-npm-v1' },
    verification,
    changes: { allowed: ['**'], protected: ['package.json', 'package-lock.json', '.github/**'], maximumFiles: 30, existingTests: 'editable' },
    publication: 'draft',
  });
  return { profile, note };
}

export type GitHubRepository = { id: number; default_branch: string; clone_url: string; private: boolean };

export type OnboardDependencies = {
  /** Fetch repository metadata; defaults to the authenticated gh CLI. */
  lookup?: (name: string) => Promise<GitHubRepository>;
  /** Clone the repository into the directory; defaults to gh repo clone. */
  clone?: (name: string, directory: string) => Promise<void>;
};

async function ghLookup(name: string): Promise<GitHubRepository> {
  const { stdout } = await execute('gh', ['api', `repos/${name}`], { timeout: 30000, maxBuffer: 4000000 });
  const raw = JSON.parse(stdout) as GitHubRepository;
  return { id: raw.id, default_branch: raw.default_branch, clone_url: raw.clone_url, private: raw.private };
}
async function ghClone(name: string, directory: string) {
  await execute('gh', ['repo', 'clone', name, directory, '--', '--quiet'], { timeout: 600000, maxBuffer: 4000000 });
}

/** Clone, detect, write the profile and publication config, and register. Idempotent for an already onboarded name. */
export async function onboardRepository(registry: RepositoryRegistry, name: string, dependencies: OnboardDependencies = {}) {
  RepositoryName.parse(name);
  const existing = registry.get(name);
  if (existing?.origin === 'config') throw new Error('repository_fixed_by_config');
  const remote = await (dependencies.lookup ?? ghLookup)(name);
  const home = registry.home(name);
  const checkout = existing?.checkout ?? join(home, 'checkout');
  await mkdir(home, { recursive: true, mode: 0o700 });
  let cloned = false;
  try { await readFile(join(checkout, '.git', 'HEAD')); } catch { await (dependencies.clone ?? ghClone)(name, checkout); cloned = true; }
  const runtime = registry.options.nodeRuntime ? Runtime.parse(await readJson(registry.options.nodeRuntime)) : undefined;
  const nodeRuntime = runtime?.schemaVersion === 1 ? runtime : undefined;
  const detected = await detectProfile(checkout, name, remote.id, remote.default_branch, nodeRuntime);
  let implementation: RepositoryEntry['implementation'];
  if (detected.profile) {
    const profileFile = join(home, 'profile.json');
    const publicationFile = join(home, 'publication.json');
    await atomicJson(profileFile, detected.profile);
    await atomicJson(publicationFile, { schemaVersion: 1, stateDirectory: join(home, 'publications'), targets: [{ repository: name, repositoryId: remote.id, baseBranch: remote.default_branch }] });
    implementation = { profile: profileFile, runtime: resolve(registry.options.nodeRuntime!), publication: publicationFile, target: 0 };
  }
  const entry = await registry.save({ name, checkout, ...(implementation ? { implementation } : {}), origin: 'registry', onboardedAt: existing?.onboardedAt ?? new Date().toISOString() });
  return { entry, cloned, note: detected.note, defaultBranch: remote.default_branch, private: remote.private };
}

/** Fields a person may change on an onboarded repository's profile. */
export const ProfileUpdate = z.object({
  allowedPaths: z.array(z.string().min(1).max(180)).min(1).max(100).optional(),
  protectedPaths: z.array(z.string().min(1).max(180)).max(100).optional(),
  maximumFiles: z.number().int().min(1).max(30).optional(),
  existingTests: z.enum(['append-only', 'editable']).optional(),
  build: z.object({ bin: z.string().min(1).max(80), args: z.array(z.string().min(1).max(80)).max(16).default([]) }).strict().optional(),
  testFiles: z.array(z.string().min(1).max(180)).min(1).max(50).optional(),
  baseBranch: z.string().min(1).max(100).optional(),
}).strict();
export type ProfileUpdate = z.infer<typeof ProfileUpdate>;

export async function updateRepository(registry: RepositoryRegistry, name: string, update: ProfileUpdate) {
  const entry = registry.get(name);
  if (!entry) throw new Error('repository_not_registered');
  if (entry.origin === 'config') throw new Error('repository_fixed_by_config');
  if (!entry.implementation) throw new Error('repository_has_no_profile');
  const profile = RepositoryProfile.parse(await readJson(entry.implementation.profile));
  if (profile.execution.adapter !== 'node-typescript-v1') throw new Error('only_node_profiles_are_editable');
  const next = structuredClone(profile) as z.infer<typeof NodeRepositoryProfile>;
  if (update.allowedPaths) next.changes.allowed = update.allowedPaths;
  if (update.protectedPaths) next.changes.protected = update.protectedPaths;
  if (update.maximumFiles) next.changes.maximumFiles = update.maximumFiles;
  if (update.existingTests) next.changes.existingTests = update.existingTests;
  if (update.baseBranch) next.baseBranch = update.baseBranch;
  if (update.build) next.verification = { required: ['node-build'], build: update.build, ...('limits' in next.verification && next.verification.limits ? { limits: next.verification.limits } : {}) };
  if (update.testFiles) next.verification = { required: ['node-typecheck', 'node-tests'], testFiles: update.testFiles, ...('limits' in next.verification && next.verification.limits ? { limits: next.verification.limits } : {}) };
  const parsed = NodeRepositoryProfile.parse(next);
  await atomicJson(entry.implementation.profile, parsed);
  if (update.baseBranch) {
    const publication = await readJson(entry.implementation.publication) as { targets: { baseBranch: string }[] };
    publication.targets[entry.implementation.target].baseBranch = update.baseBranch;
    await atomicJson(entry.implementation.publication, publication);
  }
  return parsed;
}
