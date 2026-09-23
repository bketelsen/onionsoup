import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { OwnerDeclaration } from './declarations.ts';
import { describeAsk } from './requests.ts';
import type { Runtime } from './runtime.ts';

export const DESK_LIMITS = { notes: 40, registerChars: 20_000 };

const REGISTERS = ['MAP', 'WISDOM', 'decisions', 'open-questions', 'FAILURES'] as const;
const NOTE_KINDS = new Set(['chat-decision', 'chat-action', 'retracted', 'work-opened', 'plan-approved', 'plan-rejected', 'published', 'rebase-pushed', 'attention']);
const DONE = new Set(['landed', 'failed', 'rejected']);

interface JournalLine { at: string; kind: string; note?: string; quote?: string; outcome?: string; session?: string; workItem?: string; stage?: string }

async function journal(directory: string) {
  const files = (await readdir(join(directory, 'journal')).catch(() => [])).filter(name => name.endsWith('.jsonl')).sort();
  const lines = (await Promise.all(files.map(file => readFile(join(directory, 'journal', file), 'utf8')))).join('').split('\n').filter(Boolean);
  return lines.map(line => JSON.parse(line) as JournalLine);
}

function pickOwner(runtime: Runtime, query: DeskQuery) {
  const owners = [...runtime.declarations.owners.values()];
  const byId = query.owner ? owners.find(owner => owner.id === query.owner) : undefined;
  const byAgent = query.agent ? owners.find(owner => owner.persona?.name === query.agent) : undefined;
  const deskOf = (owner: OwnerDeclaration) => resolve(runtime.desksRoot, owner.id);
  const byDirectory = query.directory ? owners.find(owner => resolve(query.directory!).startsWith(deskOf(owner))) : undefined;
  return byId ?? byAgent ?? byDirectory ?? owners.find(owner => owner.persona);
}

export interface DeskQuery { agent?: string; directory?: string; owner?: string }

/** Everything Bellonda's Desk (or any owner's) shows, in one read-only snapshot. */
export async function deskState(runtime: Runtime, query: DeskQuery) {
  const owners = [...runtime.declarations.owners.values()].filter(owner => owner.persona).map(owner => ({ id: owner.id, name: owner.persona!.name, title: owner.persona!.title }));
  const owner = pickOwner(runtime, query);
  if (!owner) return { owners, owner: null };
  const notebook = runtime.notebook(owner.id);
  const registers = Object.fromEntries(await Promise.all(REGISTERS.map(async register => [
    register,
    (await readFile(join(notebook.directory, `${register}.md`), 'utf8').catch(() => '')).slice(0, DESK_LIMITS.registerChars),
  ])));
  const entries = await journal(notebook.directory);
  const retracted = new Set(entries.filter(entry => entry.kind === 'retracted').map(entry => entry.note ?? ''));
  const seenQuotes: string[] = [];
  const isDuplicate = (entry: JournalLine) => {
    const quote = entry.quote?.trim();
    if (entry.kind !== 'chat-decision' || !quote) return false;
    const duplicate = seenQuotes.some(seen => seen.includes(quote) || quote.includes(seen));
    seenQuotes.push(quote);
    return duplicate;
  };
  const notes = entries.filter(entry => NOTE_KINDS.has(entry.kind) && entry.kind !== 'retracted').filter(entry => !isDuplicate(entry))
    .slice(-DESK_LIMITS.notes).reverse()
    .map(entry => ({ ...entry, retracted: retracted.has(entry.note ?? '') }));
  const items = (await runtime.ledger.list()).filter(item => item.owner === owner.id);
  const requests = (await runtime.requests.list()).filter(request => request.from === owner.id || request.to === owner.id);
  const pending = [
    ...items.filter(item => item.status === 'awaiting-plan-approval').map(item => ({ kind: 'plan', id: item.id, title: item.proposal.title, detail: item.plan?.summary ?? item.proposal.goal })),
    ...items.filter(item => item.status === 'awaiting-push-approval').map(item => ({ kind: 'push', id: item.id, title: item.proposal.title, detail: item.rebaseOf?.prUrl ?? '' })),
    ...requests.filter(request => request.status === 'awaiting-create-approval').map(request => ({
      kind: 'create', id: request.id, detail: request.ask.purpose,
      title: request.ask.kind === 'instance' ? `Create ${request.decision?.remote}:${request.decision?.nameSuffix} (${request.decision?.image})` : describeAsk(request.ask),
    })),
    ...requests.filter(request => request.status === 'awaiting-delete-approval').map(request => ({ kind: 'delete', id: request.id, title: `Delete ${request.instance?.remote}:${request.instance?.name}`, detail: request.followUpResult?.summary ?? '' })),
  ];
  const work = items.filter(item => !DONE.has(item.status)).map(item => ({ id: item.id, status: item.status, title: item.proposal.title }));
  const recent = items.filter(item => DONE.has(item.status)).slice(-5).reverse().map(item => ({ id: item.id, status: item.status, title: item.proposal.title, url: item.publication?.url }));
  return {
    owners,
    owner: { id: owner.id, name: owner.persona?.name ?? owner.id, title: owner.persona?.title ?? '', source: owner.persona?.source ?? '', model: owner.model, desk: resolve(runtime.desksRoot, owner.id) },
    pending,
    work,
    recent,
    notes,
    registers,
  };
}
