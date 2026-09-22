import { z } from 'zod';
import type { Capability } from '@onionsoup/job-host';
import { readJson } from '@onionsoup/runtime/storage';
import { RepositoryProfile } from '@onionsoup/implementation/project/repository-profile';
import { RepositoryName, RepositoryRegistry, ProfileUpdate, onboardRepository, updateRepository, type OnboardDependencies } from './registry.ts';

const RegisteredRepository = z.object({
  name: z.string(),
  origin: z.enum(['config', 'registry']),
  checkout: z.boolean(),
  implementation: z.boolean(),
  onboardedAt: z.string().optional(),
  profile: z.json().optional(),
}).strict();

export async function describeEntry(registry: RepositoryRegistry, name: string) {
  const entry = registry.get(name)!;
  let profile: unknown;
  if (entry.implementation) {
    try {
      const parsed = RepositoryProfile.parse(await readJson(entry.implementation.profile));
      profile = { adapter: parsed.execution.adapter, baseBranch: parsed.baseBranch, verification: parsed.verification, changes: parsed.changes };
    } catch {
      profile = { error: 'profile_unreadable' };
    }
  }
  return RegisteredRepository.parse({ name: entry.name, origin: entry.origin, checkout: Boolean(entry.checkout), implementation: Boolean(entry.implementation), onboardedAt: entry.onboardedAt, profile });
}

/** Capabilities that manage which repositories the host works on. */
export function onboardingCapabilities(registry: RepositoryRegistry, dependencies: OnboardDependencies = {}): Capability[] {
  const common = { version: 'v1', metadata: { registry: registry.options.directory, nodeRuntime: Boolean(registry.options.nodeRuntime) } };

  const list: Capability = {
    ...common,
    id: 'repository.list',
    timeoutMs: 30000,
    description: 'List the repositories the host works on, with whether each has a checkout and an implementation profile.',
    input: z.object({}).strict(),
    output: z.object({ repositories: z.array(RegisteredRepository) }).strict(),
    outcome: (result) => ({ status: 'ok', label: `${result.repositories.length} repositories` }),
    effects: [],
    execute: async () => ({ repositories: await Promise.all(registry.names().map((name) => describeEntry(registry, name))) }),
  };

  const onboard: Capability = {
    ...common,
    id: 'repository.onboard',
    timeoutMs: 900000,
    lane: () => 'registry',
    description: 'Clone a GitHub repository into the host, detect how to verify it, and register it for reads and, when possible, implementation.',
    input: z.object({ repository: RepositoryName }).strict(),
    output: z.object({ repository: RegisteredRepository, cloned: z.boolean(), note: z.string(), defaultBranch: z.string(), private: z.boolean() }).strict(),
    outcome: (result) => ({ status: result.repository.implementation ? 'ok' : 'partial', label: result.note.slice(0, 200) }),
    effects: ['github_reads', 'git_clone', 'local_artifacts'],
    execute: async ({ repository }) => {
      const result = await onboardRepository(registry, repository, dependencies);
      return { repository: await describeEntry(registry, repository), cloned: result.cloned, note: result.note, defaultBranch: result.defaultBranch, private: result.private };
    },
  };

  const update: Capability = {
    ...common,
    id: 'repository.update',
    timeoutMs: 30000,
    lane: () => 'registry',
    description: 'Change an onboarded repository\'s profile: editable paths, protected paths, file limit, test policy, build command, test files or base branch.',
    get input() { return z.object({ repository: registry.schema(), ...ProfileUpdate.shape }).strict(); },
    output: z.object({ repository: RegisteredRepository }).strict(),
    outcome: () => ({ status: 'ok', label: 'profile updated' }),
    effects: ['local_artifacts'],
    execute: async ({ repository, ...changes }) => {
      await updateRepository(registry, repository, ProfileUpdate.parse(changes));
      return { repository: await describeEntry(registry, repository) };
    },
  };

  return [list, onboard, update];
}
