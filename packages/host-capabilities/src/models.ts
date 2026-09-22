import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Capability } from '@onionsoup/job-host';
import { atomicJson, optionalJson } from '@onionsoup/runtime/storage';
import { ModelChoice, ProviderCatalog, catalog, liveModel, type ModelResolver, type ProviderId } from '@onionsoup/providers';
import type { RepoAgentId } from '@onionsoup/repository-analysis';
import type { ProposalAgentId } from '@onionsoup/maintenance/proposal/contracts';
import type { FixtureAgentId } from '@onionsoup/implementation/fixture/contracts';

type HostAgentId = RepoAgentId | ProposalAgentId | FixtureAgentId | 'chat' | 'bug-readiness' | 'code-location' | 'container-triage' | 'workload-triage';

/** Every agent that calls a model, and what it does, for the operator choosing its model. */
export const MODEL_AGENTS = {
  chat: 'Answers in chat and decides which capabilities to run.',
  'bug-readiness': 'Classifies one issue and judges whether a bug report is ready to investigate.',
  'code-location': 'Finds the code and tests relevant to a ready bug.',
  'repository-themes': 'Groups open issues and pull requests into maintainer themes for a brief.',
  'repository-health': 'Explains observed maintenance activity for a brief.',
  'maintenance-actions': 'Suggests immediate maintainer actions for a brief.',
  'feature-requirements': 'Extracts requirements from a feature request.',
  'change-proposal': 'Drafts a change proposal from cited source.',
  'scoped-patch': 'Writes the patch for an accepted task.',
  'change-review': 'Reviews a verified candidate before it can be published.',
  'container-triage': 'Assesses containers on Docker, Podman and Incus hosts.',
  'workload-triage': 'Assesses k3s workloads.',
} as const satisfies Record<HostAgentId, string>;

export const ModelAgentId = z.enum(Object.keys(MODEL_AGENTS) as [HostAgentId, ...HostAgentId[]]);
export type ModelAgentId = z.infer<typeof ModelAgentId>;

/** Operator configuration: the model every agent uses unless one is named for it. */
export const ModelConfig = z.object({
  default: ModelChoice,
  agents: z.partialRecord(ModelAgentId, ModelChoice).default({}),
}).strict();
export type ModelConfig = z.infer<typeof ModelConfig>;

const AssignmentFile = z.object({ schemaVersion: z.literal(1), agents: z.partialRecord(ModelAgentId, ModelChoice) }).strict();

export type ModelOrigin = 'assigned' | 'config' | 'default';
export type ModelRegistryOptions = {
  /** Where assignments made from the web persist; empty for a registry that never persists. */
  directory: string;
  config: ModelConfig;
};

/** Which model each agent runs on: web assignments over configured agents over the configured default. */
export class ModelRegistry {
  private assignments: Partial<Record<ModelAgentId, ModelChoice>> = {};
  private constructor(readonly options: ModelRegistryOptions) {}

  static fixed(config: ModelConfig) {
    return new ModelRegistry({ directory: '', config: ModelConfig.parse(config) });
  }

  static async open(options: ModelRegistryOptions) {
    const registry = new ModelRegistry({ ...options, config: ModelConfig.parse(options.config) });
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const saved = await optionalJson(registry.file);
    if (saved !== undefined) registry.assignments = AssignmentFile.parse(saved).agents;
    return registry;
  }

  private get file() { return join(this.options.directory, 'assignments.json'); }

  choice(agent: ModelAgentId): { choice: ModelChoice; origin: ModelOrigin } {
    const assigned = this.assignments[agent];
    if (assigned) return { choice: assigned, origin: 'assigned' };
    const configured = this.options.config.agents[agent];
    if (configured) return { choice: configured, origin: 'config' };
    return { choice: this.options.config.default, origin: 'default' };
  }

  /** Opens each agent's model when it runs, so a new assignment applies to the next run without a restart. */
  resolver(open: typeof liveModel = liveModel): ModelResolver {
    return async (agent) => {
      const parsed = ModelAgentId.safeParse(agent);
      if (!parsed.success) throw new Error(`unknown_model_agent:${agent}`);
      const { choice } = this.choice(parsed.data);
      return open(choice.model, choice.provider);
    };
  }

  /** Set one agent's model, or clear it with null to fall back to configuration. */
  async assign(agent: ModelAgentId, choice: ModelChoice | null) {
    if (!this.options.directory) throw new Error('model_assignments_not_persisted');
    const next = { ...this.assignments };
    if (choice) next[agent] = choice;
    else delete next[agent];
    await atomicJson(this.file, AssignmentFile.parse({ schemaVersion: 1, agents: next }));
    this.assignments = next;
    return this.choice(agent);
  }

  describe() {
    return ModelAgentId.options.map((agent) => ({
      agent,
      description: MODEL_AGENTS[agent],
      ...this.choice(agent),
      configured: this.options.config.agents[agent] ?? this.options.config.default,
    }));
  }
}

export const ModelAssignment = z.object({
  agent: ModelAgentId,
  choice: z.object({ provider: z.string(), model: z.string(), origin: z.enum(['assigned', 'config', 'default']) }).strict(),
}).strict();

export type CatalogReader = (provider: ProviderId) => Promise<ProviderCatalog>;

/** A model may be assigned only when its provider is signed in and lists it. */
async function assertListed(choice: ModelChoice, readCatalog: CatalogReader) {
  const listing = await readCatalog(choice.provider);
  if (listing.status === 'signed_out') throw new Error(`provider_signed_out:${choice.provider}`);
  if (listing.status === 'unavailable') throw new Error(`model_catalog_unavailable:${choice.provider}:${listing.reason}`);
  if (!listing.models.some((m) => m.id === choice.model)) throw new Error(`model_not_in_catalog:${choice.provider}/${choice.model}`);
}

const AssignInput = z.object({ agent: ModelAgentId, choice: ModelChoice.optional() }).strict();

/** Capabilities that change which model an agent runs on. Listing goes through GET /v1/models. */
export function modelCapabilities(registry: ModelRegistry, readCatalog: CatalogReader = catalog): Capability[] {
  const assign: Capability = {
    id: 'models.assign',
    version: 'v1',
    timeoutMs: 60000,
    lane: () => 'models',
    description: 'Choose the provider and model one agent runs on, from the models the signed-in providers list. Omit the choice to return the agent to its configured model.',
    interactive: true,
    input: AssignInput,
    output: ModelAssignment,
    outcome: (result) => ({ status: 'ok', label: `${result.agent}: ${result.choice.provider}/${result.choice.model}` }),
    metadata: { agents: ModelAgentId.options },
    effects: ['local_artifacts'],
    execute: async ({ agent, choice }: z.infer<typeof AssignInput>) => {
      if (choice) await assertListed(choice, readCatalog);
      const next = await registry.assign(agent, choice ?? null);
      return { agent, choice: { ...next.choice, origin: next.origin } };
    },
  };
  return [assign];
}
