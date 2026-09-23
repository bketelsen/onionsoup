import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tool, type Plugin } from '@opencode-ai/plugin';
import type { OwnerDeclaration, Persona } from './declarations.ts';
import { pickModel } from './families.ts';
import type { Notebook } from './notebook.ts';
import { rosterText } from './roster.ts';
import { Runtime } from './runtime.ts';

/**
 * onionsoup as an opencode plugin: every owner with a persona becomes an agent a person can chat with
 * (in OpenChamber or the opencode TUI). The owner reaches for its own tools first; anything else follows
 * its conversation-mode rules, where "ask" means the person approves in the chat. What the owner does is
 * journaled deterministically; what the person decides is picked out by a small watcher model and
 * journaled as a candidate, and the owner's distill decides what enters the notebook.
 *
 * The daemon's sandboxed servers load the same global config; ONIONSOUP_SANDBOX keeps this plugin inert
 * there, so autonomous runs keep their deny-by-default rules.
 */
export const PLUGIN_LIMITS = { exchangeChars: 8_000, contextChars: 28_000 };

const WATCHER_AGENT = 'onionsoup-watcher';
const WATCHER_MODELS = ['openai/gpt-5.6-luna-fast', 'github-copilot/claude-haiku-4.5'];

/** Tools that change things; a completed call of one of these is always journaled. */
const MUTATING_TOOLS = new Set(['edit', 'write', 'apply_patch', 'patch', 'multiedit']);

function globMatches(pattern: string, value: string) {
  const expression = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  return new RegExp(`^${expression}$`, 's').test(value);
}

/** opencode semantics: the last matching rule wins. */
function bashAction(rules: Record<string, string>, command: string) {
  let action = 'ask';
  for (const [pattern, value] of Object.entries(rules)) if (globMatches(pattern, command.trim())) action = value;
  return action;
}

/** The owner's own verification commands, with {tools} resolved; chats may run these without asking. */
function verifyCommands(owner: OwnerDeclaration, toolsDirectory: string) {
  if (owner.domain.kind !== 'git-repository') return [];
  return owner.domain.verify.map(words => words.map(word => word.replaceAll('{tools}', toolsDirectory)).join(' '));
}

function agentPrompt(owner: OwnerDeclaration, persona: Persona, charter: string, roster: string, verify: readonly string[]) {
  return `${persona.voice.trim()}

<charter>
${charter.trim()}
</charter>

<roster>
${roster}
</roster>

How you work with the person in this chat:
- You are the owner of this domain (${owner.domain.kind === 'git-repository' ? owner.domain.name : 'incus remotes'}). Reach for your onionsoup tools first:
  onionsoup_status (your open work and anything waiting on the person), onionsoup_notebook (your full notebook),
  onionsoup_evidence (what other owners observed), onionsoup_open_work (hand a change to freelancers with a plan the person
  approves), onionsoup_record_decision and onionsoup_retract.
- For substantial changes, prefer opening work so freelancers plan, implement and review it with the person's gates. For
  small, clearly requested actions you may act directly; anything outside your safe commands asks the person first.
- Record a decision only when the person states one or explicitly agrees to your proposal, and quote their words. A
  watcher also notes decisions after each exchange; you do not need to record everything.
- Your notebook and current work are appended to your context each turn. Never put secrets into notes or files.${verify.length ? `
- Verify changes in your domain with these commands (they run without asking): ${verify.map(command => `\`${command}\``).join(', ')}.` : ''}
- If a tool fails, say so plainly and say what failed. Never tell the person something was recorded, opened or done
  unless the tool confirmed it; an unrecorded decision is recoverable, a false claim about the record is not.`;
}

function conversationPermission(owner: OwnerDeclaration, verify: readonly string[]) {
  const mode = owner.conversation ?? { bash: { '*': 'ask' }, edit: 'ask', webfetch: 'ask' };
  const bash = { ...mode.bash, ...Object.fromEntries(verify.map(command => [`${command}*`, 'allow'])) };
  return { edit: mode.edit, bash, webfetch: mode.webfetch, external_directory: 'ask', doom_loop: 'ask' };
}

const WATCHER_PERMISSION = Object.fromEntries(
  ['edit', 'bash', 'webfetch', 'websearch', 'read', 'glob', 'grep', 'list', 'task', 'external_directory', 'todowrite', 'question'].map(key => [key, 'deny']),
);

const WatcherRecords = tool.schema.object({
  records: tool.schema.array(tool.schema.object({
    kind: tool.schema.enum(['decision', 'preference', 'pronouncement', 'agreement']),
    statement: tool.schema.string().describe('The decision in one sentence, in the third person'),
    quote: tool.schema.string().describe("The person's exact words that establish it, copied verbatim"),
  })),
});

function watcherBrief(persona: Persona, userText: string, assistantText: string) {
  return `You read one exchange between a person and ${persona.name}, an assistant who owns part of their homelab.
Extract ONLY decisions, preferences or pronouncements the PERSON made, or proposals by ${persona.name} that the person
explicitly agreed to in this message. Every record must quote the person's exact words, copied verbatim from their message.
Not decisions: questions, thinking aloud, requests for a one-off task, anything ${persona.name} said on its own.
Precision matters far more than recall: when unsure, return no records.

<person>
${userText.slice(0, PLUGIN_LIMITS.exchangeChars)}
</person>

<${persona.name}>
${assistantText.slice(0, PLUGIN_LIMITS.exchangeChars)}
</${persona.name}>`;
}

interface MessagePart { type: string; text?: string; synthetic?: boolean }
interface SessionMessage { info: { id: string; role: string }; parts: MessagePart[] }

function textOf(parts: readonly MessagePart[]) {
  return parts.filter(part => part.type === 'text' && !part.synthetic).map(part => part.text ?? '').join('\n').trim();
}

/** Two processes (daemon and plugin) write notebooks; a busy git index is fine, the next commit picks it up. */
async function commitQuietly(notebook: Notebook, message: string) {
  await notebook.commit(message).catch(() => undefined);
}

const server: Plugin = async (input, options) => {
  if (process.env.ONIONSOUP_SANDBOX === '1') return {};
  const runtime = await Runtime.open({ declarations: String(options?.declarations), state: String(options?.state) });
  const owners = [...runtime.declarations.owners.values()].filter(owner => owner.persona);
  const ownerByAgent = new Map(owners.map(owner => [owner.persona!.name, runtime.owner(owner.id)]));
  // Persona owners can be chatted with before their first duty ever runs, so their notebooks must exist.
  for (const owner of owners) {
    const charter = await runtime.text(`charters/${owner.id}.md`).catch(() => `# Charter: ${owner.id}\n`);
    await runtime.notebook(owner.id).ensure(charter).catch(() => undefined);
  }
  const sessionOwner = new Map<string, OwnerDeclaration>();
  const journaledParts = new Set<string>();
  const watchedMessages = new Map<string, string>();

  function requireOwner(agent: string) {
    const owner = ownerByAgent.get(agent);
    if (!owner) throw new Error(`onionsoup tools are for owners; ${agent} is not one`);
    return owner;
  }

  async function workSummary(ownerId: string) {
    const items = (await runtime.ledger.list()).filter(item => item.owner === ownerId && !['landed', 'failed', 'rejected'].includes(item.status));
    const requests = (await runtime.requests.list()).filter(request => (request.from === ownerId || request.to === ownerId) && !['deleted', 'declined', 'denied', 'failed'].includes(request.status));
    const lines = [
      ...items.map(item => `- work ${item.id}: ${item.status}: ${item.proposal.title}`),
      ...requests.map(request => `- request ${request.id}: ${request.status}: ${request.from} → ${request.to} ${request.ask.image}`),
    ];
    return lines.join('\n') || '(nothing open)';
  }

  /** Quotes already noted as decisions in this chat, by the owner or an earlier watch. */
  async function sessionQuotes(ownerId: string, sessionID: string) {
    const directory = join(runtime.notebook(ownerId).directory, 'journal');
    const files = (await readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.jsonl'));
    const lines = (await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')))).join('').split('\n').filter(Boolean);
    return lines.map(line => JSON.parse(line) as { kind: string; session?: string; quote?: string })
      .filter(entry => entry.kind === 'chat-decision' && entry.session === sessionID && entry.quote)
      .map(entry => entry.quote!.trim());
  }

  async function watch(sessionID: string, owner: OwnerDeclaration) {
    const messages = ((await input.client.session.messages({ path: { id: sessionID } })).data ?? []) as unknown as SessionMessage[];
    const lastUser = messages.map(message => message.info.role).lastIndexOf('user');
    if (lastUser < 0) return;
    const userMessage = messages[lastUser]!;
    if (watchedMessages.get(sessionID) === userMessage.info.id) return;
    watchedMessages.set(sessionID, userMessage.info.id);
    const userText = textOf(userMessage.parts);
    const assistantText = messages.slice(lastUser + 1).map(message => textOf(message.parts)).join('\n');
    if (!userText) return;
    const ownerFamily = runtime.family(owner.model);
    const { model } = pickModel(runtime.declarations.families, WATCHER_MODELS, [ownerFamily]);
    const [providerID, ...modelParts] = model.split('/');
    const child = await input.client.session.create({ body: { title: `${owner.persona!.name}: decision watcher`, parentID: sessionID } });
    const childID = child.data?.id;
    if (!childID) return;
    try {
      const reply = await input.client.session.prompt({
        path: { id: childID },
        body: {
          agent: WATCHER_AGENT,
          model: { providerID: providerID!, modelID: modelParts.join('/') },
          format: { type: 'json_schema', schema: tool.schema.toJSONSchema(WatcherRecords) },
          parts: [{ type: 'text', text: watcherBrief(owner.persona!, userText, assistantText) }],
        } as never,
      });
      const parsed = WatcherRecords.safeParse((reply.data?.info as { structured?: unknown } | undefined)?.structured);
      if (!parsed.success) return;
      const notebook = runtime.notebook(owner.id);
      const alreadyNoted = await sessionQuotes(owner.id, sessionID);
      const overlaps = (quote: string) => alreadyNoted.some(noted => noted.includes(quote) || quote.includes(noted));
      // A quote not really in the person's message is a hallucination; one already noted in this session is a duplicate.
      const fresh = parsed.data.records.filter(candidate => candidate.quote.trim() && userText.includes(candidate.quote.trim()) && !overlaps(candidate.quote.trim()));
      for (const record of fresh) {
        await notebook.journal({ kind: 'chat-decision', outcome: record.kind, note: record.statement, quote: record.quote, session: sessionID, model });
      }
      await commitQuietly(notebook, 'chat decisions');
    } finally {
      await input.client.session.delete({ path: { id: childID } }).catch(() => undefined);
    }
  }

  return {
    async config(config) {
      const agents = (config.agent ??= {}) as Record<string, unknown>;
      for (const owner of owners) {
        const persona = owner.persona!;
        const charter = await runtime.text(`charters/${owner.id}.md`).catch(() => '(no charter yet)');
        const verify = verifyCommands(owner, runtime.toolsDirectory);
        agents[persona.name] = {
          mode: 'primary',
          description: `${persona.title} (${persona.source})`,
          model: owner.model,
          prompt: agentPrompt(owner, persona, charter, rosterText(runtime.declarations, owner.id), verify),
          permission: conversationPermission(owner, verify),
        };
      }
      agents[WATCHER_AGENT] = {
        mode: 'primary',
        hidden: true,
        description: 'onionsoup: extracts decisions from owner chats',
        prompt: 'You extract decisions from conversations and answer only with the structured output requested.',
        permission: WATCHER_PERMISSION,
      };
    },

    async 'chat.message'(message) {
      const owner = message.agent ? ownerByAgent.get(message.agent) : undefined;
      if (owner) sessionOwner.set(message.sessionID, owner);
    },

    async 'experimental.chat.system.transform'(context, output) {
      const owner = context.sessionID ? sessionOwner.get(context.sessionID) : undefined;
      if (!owner) return;
      const notebook = await runtime.notebook(owner.id).orientation().catch(() => '(notebook unavailable)');
      const work = await workSummary(owner.id);
      output.system.push(`<your-notebook>\n${notebook.slice(0, PLUGIN_LIMITS.contextChars)}\n</your-notebook>\n\n<your-open-work>\n${work}\n</your-open-work>`);
    },

    async event({ event }) {
      const typed = event as { type: string; properties: Record<string, any> };
      const isIdle = typed.type === 'session.idle' || (typed.type === 'session.status' && typed.properties.status?.type === 'idle');
      if (isIdle) {
        const owner = sessionOwner.get(typed.properties.sessionID);
        if (owner) await watch(typed.properties.sessionID, owner).catch(() => undefined);
        return;
      }
      if (typed.type !== 'message.part.updated') return;
      const part = typed.properties.part as { id: string; sessionID: string; type: string; tool?: string; state?: { status: string; input?: any; output?: string } };
      const owner = sessionOwner.get(part.sessionID);
      if (!owner || part.type !== 'tool' || part.state?.status !== 'completed' || journaledParts.has(part.id)) return;
      const command = part.tool === 'bash' ? String(part.state.input?.command ?? '') : '';
      const rules = (owner.conversation?.bash ?? { '*': 'ask' }) as Record<string, string>;
      const isAction = MUTATING_TOOLS.has(part.tool ?? '') || (part.tool === 'bash' && bashAction(rules, command) !== 'allow');
      if (!isAction) return;
      journaledParts.add(part.id);
      const target = command || String(part.state.input?.filePath ?? part.state.input?.patchText?.split('\n')[1] ?? '');
      const notebook = runtime.notebook(owner.id);
      await notebook.journal({ kind: 'chat-action', stage: part.tool, note: target.slice(0, 500), outcome: (part.state.output ?? '').slice(0, 300), session: part.sessionID });
      await commitQuietly(notebook, 'chat action');
    },

    tool: {
      onionsoup_status: tool({
        description: 'Your open work items and requests, including anything waiting on the person.',
        args: {},
        async execute(_args, context) {
          return workSummary(requireOwner(context.agent).id);
        },
      }),
      onionsoup_notebook: tool({
        description: 'Read your notebook: the whole orientation, or one register (CHARTER, MAP, WISDOM, FAILURES, decisions, open-questions).',
        args: { register: tool.schema.enum(['all', 'CHARTER', 'MAP', 'WISDOM', 'FAILURES', 'decisions', 'open-questions']).default('all') },
        async execute(args, context) {
          const notebook = runtime.notebook(requireOwner(context.agent).id);
          return args.register === 'all' ? notebook.orientation() : readFile(join(notebook.directory, `${args.register}.md`), 'utf8');
        },
      }),
      onionsoup_evidence: tool({
        description: "Another owner's latest observations of its domain (e.g. homelab-virt's incus snapshot, or a repository owner's MAP).",
        args: { owner: tool.schema.string().describe('The owner id, e.g. homelab-virt') },
        async execute(args, context) {
          requireOwner(context.agent);
          const other = runtime.owner(args.owner);
          const snapshot = await readFile(join(other.workspace, 'SNAPSHOT.md'), 'utf8').catch(() => '');
          return snapshot || readFile(join(runtime.notebook(other.id).directory, 'MAP.md'), 'utf8');
        },
      }),
      onionsoup_open_work: tool({
        description: 'Hand a change to freelancers: opens a work item that is planned, approved by the person, implemented and reviewed.',
        args: {
          title: tool.schema.string(),
          goal: tool.schema.string(),
          rationale: tool.schema.string(),
          acceptance: tool.schema.array(tool.schema.string()).min(1),
          size: tool.schema.enum(['small', 'medium']),
        },
        async execute(args, context) {
          const owner = requireOwner(context.agent);
          if (!owner.workflow) return `${owner.persona!.name} has no workflow for change work; raise it with the person instead.`;
          const item = await runtime.ledger.create(owner.id, owner.workflow, args);
          const notebook = runtime.notebook(owner.id);
          await notebook.journal({ kind: 'work-opened', workItem: item.id, note: args.title, session: context.sessionID });
          await commitQuietly(notebook, `journal ${item.id}`);
          return `Opened ${item.id}. The daemon plans it next; the person approves the plan before anything is implemented.`;
        },
      }),
      onionsoup_record_decision: tool({
        description: "Record a decision the person made or explicitly agreed to, quoting their exact words. It goes to your journal; distill decides what enters decisions.md.",
        args: { statement: tool.schema.string(), quote: tool.schema.string() },
        async execute(args, context) {
          const owner = requireOwner(context.agent);
          const notebook = runtime.notebook(owner.id);
          await notebook.journal({ kind: 'chat-decision', outcome: 'recorded-by-owner', note: args.statement, quote: args.quote, session: context.sessionID });
          await commitQuietly(notebook, 'chat decision');
          return 'Recorded in your journal.';
        },
      }),
      onionsoup_retract: tool({
        description: 'Retract something noted from this chat that the person says was not a decision.',
        args: { what: tool.schema.string().describe('What to retract, in the words it was noted') },
        async execute(args, context) {
          const owner = requireOwner(context.agent);
          const notebook = runtime.notebook(owner.id);
          await notebook.journal({ kind: 'retracted', note: args.what, session: context.sessionID });
          await commitQuietly(notebook, 'retraction');
          return 'Retracted; distill will drop it.';
        },
      }),
    },
  };
};

export default { id: 'onionsoup-owners', server };
