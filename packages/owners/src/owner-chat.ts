import type { OwnerDeclaration, OperatorDeclaration, Persona } from './declarations.ts';

/** Existing persona agent names are stable; the observation fallback is keyed by durable owner ID. */
export function ownerChatAgent(owner: OwnerDeclaration) {
  return owner.persona?.name ?? `onionsoup-owner-${owner.id}`;
}

export function ownerChatVoice(owner: OwnerDeclaration): Persona {
  return owner.persona ?? { name: owner.id, title: `Owner of ${owner.id}`, source: 'owner configuration',
    voice: 'Be clear and factual. Separate observed evidence, inference, and unknowns.', icon: 'briefcase', color: 'primary' };
}

export const OBSERVATION_TOOLS = ['onionsoup_status', 'onionsoup_notebook', 'onionsoup_evidence', 'onionsoup_ask'] as const;

/** Defaults deny unknown tools and all configured MCP capabilities. Adding chat grants no domain effect. */
export function observationChatPermission() {
  return { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', question: 'allow',
    external_directory: 'deny', bash: 'deny', edit: 'deny', task: 'deny',
    ...Object.fromEntries(OBSERVATION_TOOLS.map(name => [name, 'allow'])) };
}

export function observationChatPrompt(owner: OwnerDeclaration, charter: string, roster: string) {
  return `You are ${owner.id}, an owner available for observation and informational consultation.
You can read your existing workspace, notebook, recorded evidence, and status. You may ask another owner for
information with onionsoup_ask, but cannot request follow-up work. Do not edit, run shell commands, dispatch
subagents, schedule reminders, change infrastructure, or submit plans. Chat availability grants no new authority.
Explain missing evidence and who could provide it. Runtime status may be stale; do not claim omniscience.

<charter>\n${charter}\n</charter>\n<roster>\n${roster}\n</roster>`;
}

/** Only new fallback identities are checked here; preserve validation of existing persona declarations. */
export function checkOwnerChatNames(owners: ReadonlyMap<string, OwnerDeclaration>, operator?: OperatorDeclaration) {
  const names = new Set(['onionsoup-watcher', 'onionsoup-implementer', ...[...owners.keys()].map(id => `onionsoup-reviewer-${id}`),
    ...[...owners.values()].flatMap(owner => owner.persona ? [owner.persona.name.toLowerCase()] : [])]);
  if (operator) names.add(operator.name.toLowerCase());
  for (const owner of owners.values()) {
    if (owner.persona) continue;
    const name = ownerChatAgent(owner).toLowerCase();
    if (names.has(name)) throw new Error(`owner_chat_agent_collision: ${owner.id}`);
    names.add(name);
  }
}
