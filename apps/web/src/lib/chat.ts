import type { ChatTurn, RegisteredRepository } from './store.svelte.ts';

export type TurnStep = { label: string; state: 'running' | 'done' | 'rejected'; jobId?: string };
type Details = Record<string, unknown> | null;

/** How each chat tool reads as a step, from the arguments it was called with. */
const TOOL_LABELS: Record<string, (details: Details) => string> = {
  discover_capabilities: () => 'Read the catalog',
  list_jobs: (details) => (details?.capability ? `Listed recent ${details.capability} jobs` : 'Listed recent jobs'),
  run_capability: (details) => `Ran ${String(details?.capability ?? 'a capability')}`,
  inspect_job: () => 'Read a job',
};
const labelOf = (tool: string, details: Details) => (TOOL_LABELS[tool] ?? (() => tool.replaceAll('_', ' ')))(details);

/** What each event stage does to the step list. */
const STAGES: Record<string, (steps: TurnStep[], event: ChatTurn['events'][number]) => void> = {
  intent: (steps, event) => {
    const details = event.details as Details;
    steps.push({ label: labelOf(event.tool, details), state: 'running', jobId: typeof details?.jobId === 'string' ? details.jobId : undefined });
  },
  result: (steps) => { if (steps.at(-1)) steps.at(-1)!.state = 'done'; },
  rejected: (steps) => { if (steps.at(-1)) steps.at(-1)!.state = 'rejected'; },
  checkpoint: (steps, event) => {
    const details = event.details as Details;
    if (details?.kind === 'job_admitted' && typeof details.jobId === 'string' && steps.at(-1)) steps.at(-1)!.jobId = details.jobId;
  },
};

/** A turn's recorded events as the steps a person would describe. */
export function stepsOf(turn: ChatTurn): TurnStep[] {
  const steps: TurnStep[] = [];
  for (const event of turn.events) STAGES[event.stage]?.(steps, event);
  return steps;
}

type StarterContext = { repository?: string; implementable?: string };
/** Conversation starters, keyed by the capability that makes each possible. They fill the composer; they never send. */
const STARTERS: Record<string, (context: StarterContext) => string | undefined> = {
  'homelab.brief': () => 'Give me a homelab brief',
  'homelab.investigate': () => 'Does anything in the homelab need attention right now?',
  'repository.brief': ({ repository }) => (repository ? `Brief ${repository} for the last two weeks` : undefined),
  'change.request': ({ implementable }) => (implementable ? `In ${implementable}, change ` : undefined),
  'repository.list': () => 'Which repositories are onboarded?',
};

export function startersFor(capabilities: string[], repositories: RegisteredRepository[]) {
  const context = { repository: repositories[0]?.name, implementable: repositories.find((repository) => repository.implementation)?.name };
  return capabilities.flatMap((id) => STARTERS[id]?.(context) ?? []);
}
