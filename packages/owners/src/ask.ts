import { Answer, AskOrigin, readAskHandoff, saveAskHandoff, resolveAskHandoff, withAskConsultation } from './ask-handoffs.ts';
export { Answer } from './ask-handoffs.ts';
import { clipped, recentChatDecisions } from './chat-context.ts';
import type { OwnerDeclaration } from './declarations.ts';
import { HireError } from './opencode.ts';
import { incusEvidenceText, refreshWorkspace } from './owner.ts';
import { rosterText } from './roster.ts';
import type { Runtime } from './runtime.ts';

function who(owner: OwnerDeclaration) {
  return owner.persona ? `${owner.persona.name} (${owner.persona.title})` : owner.id;
}

function askBrief(asker: OwnerDeclaration, question: string, notebook: string, snapshot: string, evidence: string, roster: string, decisions: string) {
  return [
    `${who(asker)}, another owner, asks you a question about your domain. Your workspace reflects your domain at ${snapshot}.`,
    `<question>\n${question}\n</question>`,
    `<your-notebook>\n${notebook}\n</your-notebook>`,
    decisions ? `<recent-person-decisions>\nRaw journal context, including decisions not yet distilled. Retractions cancel earlier matching statements; later decisions can reaffirm them.\n${decisions}\n</recent-person-decisions>` : '',
    evidence ? `<your-incus-snapshot>\n${evidence}\n</your-incus-snapshot>` : '',
    `<roster>\n${roster}\n</roster>`,
    `Answer from your notebook, your workspace and your evidence; read files as needed.
This consultation is read-only: you may not change anything during this interaction. A status-only question does not
authorize follow-up work. This restriction does not cancel a separately accepted work request or its approved plan;
those continue under their own scope and gates.
Separate what you observed (with its source) from what you infer, and say plainly what you do not know. If the question
is about another owner's domain, say whose it is instead of answering for them.`,
  ].filter(Boolean).join('\n\n');
}

export function resolveOwnerId(runtime: Runtime, name: string) {
  const match = [...runtime.declarations.owners.values()].find(owner => owner.id === name || owner.persona?.name.toLowerCase() === name.toLowerCase());
  if (!match) throw new Error(`unknown owner: ${name}`);
  return match.id;
}

/** An answer whose shape stayed wrong after a resend still carries its text: keep that rather than nothing. */
export function salvageAnswer(error: unknown) {
  const deliverable = error instanceof HireError ? error.deliverable as { answer?: unknown } | undefined : undefined;
  if (typeof deliverable?.answer !== 'string' || !deliverable.answer.trim()) throw error;
  const value: Answer = { answer: deliverable.answer, observed: [], inferred: [], unknown: ['The answer arrived malformed; only its main text survived, so its sources were lost.'] };
  return { value, sessionID: (error as HireError).sessionID, cost: 0 };
}

/** One owner asks another. The answering owner runs in its own read-only sandbox with fresh evidence. */
export async function askOwner(runtime: Runtime, fromId: string, toName: string, question: string, followUp?: { origin: AskOrigin }) {
  if (!followUp) return answerOwner(runtime, fromId, toName, question);
  runtime.owner(fromId);
  const to = resolveOwnerId(runtime, toName);
  if (to === fromId) throw new Error('an owner cannot ask itself');
  const input = { from: fromId, to, question, origin: AskOrigin.parse(followUp.origin) };
  return withAskConsultation(runtime, input, () => answerOwner(runtime, fromId, to, question, followUp));
}

async function answerOwner(runtime: Runtime, fromId: string, toName: string, question: string, followUp?: { origin: AskOrigin }) {
  const asker = runtime.owner(fromId);
  const answerer = runtime.owner(resolveOwnerId(runtime, toName));
  if (answerer.id === asker.id) throw new Error('an owner cannot ask itself');
  const handoff = followUp ? { from: asker.id, to: answerer.id, question, origin: AskOrigin.parse(followUp.origin) } : undefined;
  const saved = handoff ? await readAskHandoff(runtime, handoff) : undefined;
  if (saved && handoff) {
    return { answerer, answer: saved.answer, cost: 0, ...await resolveAskHandoff(runtime, handoff) };
  }
  const notebook = runtime.notebook(answerer.id);
  await notebook.ensure(await runtime.text(`charters/${answerer.id}.md`).catch(() => `# Charter: ${answerer.id}\n`));
  const snapshot = await refreshWorkspace(runtime, answerer);
  const brief = askBrief(asker, question, await notebook.orientation(), snapshot,
    await incusEvidenceText(runtime, answerer), rosterText(runtime.declarations, answerer.id),
    await recentChatDecisions(runtime, answerer.id)) + (handoff
      ? '\nThe caller explicitly requests useful follow-up. If appropriate, propose at most one small repository change in YOUR declared repository, with concrete acceptance criteria and its exact repository name. Host code will route it through receiver acceptance and ordinary plan/effect gates. Do not claim to have performed it. If live evidence or another capability is needed, explain that in unknown; do not fabricate a proposal. No nested referrals or infrastructure effects.'
      : '\nThis is an informational question. Do not return proposedWork or initiate any work.');
  const result = await runtime.hire(answerer.id, { role: 'owner', model: answerer.model, directory: answerer.workspace, title: `${answerer.id}: answering ${asker.id}`, brief, schema: Answer })
    .catch(error => salvageAnswer(error));
  const answer = handoff ? (await saveAskHandoff(runtime, handoff, result.value)).answer : result.value;
  const routed = handoff ? await resolveAskHandoff(runtime, handoff) : { request: undefined, handoffStatus: undefined };
  const { request, handoffStatus } = routed;
  if (!handoff) delete answer.proposedWork;
  await recordExchange(runtime, asker, answerer, question, answer).catch(error => {
    if (!handoff) throw error;
    // The paid answer and request are durable; the exchange journal is a best-effort record, not a gate.
    console.warn('handoff_exchange_record_failed');
  });
  return { answerer, answer, cost: result.cost, request, handoffStatus };
}

async function recordExchange(runtime: Runtime, asker: OwnerDeclaration, answerer: OwnerDeclaration,
  question: string, answer: Answer) {
  for (const [ownerId, kind] of [[asker.id, 'asked'], [answerer.id, 'answered']] as const) {
    const book = runtime.notebook(ownerId);
    await book.journal({ kind, note: `${asker.id} → ${answerer.id}: ${clipped(question, answerer.chatContext.entryChars)}`,
      outcome: clipped(answer.answer, answerer.chatContext.entryChars) });
    await book.commit(`journal ${kind}`).catch(() => undefined);
  }
}

export function formatAnswer(answerer: OwnerDeclaration, answer: Answer) {
  const section = (title: string, lines: readonly string[]) => (lines.length ? `\n${title}:\n${lines.map(line => `- ${line}`).join('\n')}` : '');
  return `${who(answerer)} answers:\n${answer.answer}${section('Observed', answer.observed)}${section('Inferred', answer.inferred)}${section('Unknown', answer.unknown)}`;
}
