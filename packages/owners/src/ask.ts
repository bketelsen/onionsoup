import { z } from 'zod';
import type { OwnerDeclaration } from './declarations.ts';
import { incusEvidenceText, refreshWorkspace } from './owner.ts';
import { rosterText } from './roster.ts';
import type { Runtime } from './runtime.ts';

export const Answer = z.object({
  answer: z.string().describe('The direct answer, in your own voice'),
  observed: z.array(z.string()).describe('Facts you observed, each with its source (file, snapshot, date)'),
  inferred: z.array(z.string()).describe('What you infer from them, labelled as inference'),
  unknown: z.array(z.string()).describe('What you do not know and would need to find out'),
});
export type Answer = z.infer<typeof Answer>;

function who(owner: OwnerDeclaration) {
  return owner.persona ? `${owner.persona.name} (${owner.persona.title})` : owner.id;
}

function askBrief(asker: OwnerDeclaration, question: string, notebook: string, snapshot: string, evidence: string, roster: string) {
  return [
    `${who(asker)}, another owner, asks you a question about your domain. Your workspace reflects your domain at ${snapshot}.`,
    `<question>\n${question}\n</question>`,
    `<your-notebook>\n${notebook}\n</your-notebook>`,
    evidence ? `<your-incus-snapshot>\n${evidence}\n</your-incus-snapshot>` : '',
    `<roster>\n${roster}\n</roster>`,
    `Answer from your notebook, your workspace and your evidence; read files as needed. You may not change anything.
Separate what you observed (with its source) from what you infer, and say plainly what you do not know. If the question
is about another owner's domain, say whose it is instead of answering for them.`,
  ].filter(Boolean).join('\n\n');
}

export function resolveOwnerId(runtime: Runtime, name: string) {
  const match = [...runtime.declarations.owners.values()].find(owner => owner.id === name || owner.persona?.name.toLowerCase() === name.toLowerCase());
  if (!match) throw new Error(`unknown owner: ${name}`);
  return match.id;
}

/** One owner asks another. The answering owner runs in its own read-only sandbox with fresh evidence. */
export async function askOwner(runtime: Runtime, fromId: string, toName: string, question: string) {
  const asker = runtime.owner(fromId);
  const answerer = runtime.owner(resolveOwnerId(runtime, toName));
  if (answerer.id === asker.id) throw new Error('an owner cannot ask itself');
  const notebook = runtime.notebook(answerer.id);
  await notebook.ensure(await runtime.text(`charters/${answerer.id}.md`).catch(() => `# Charter: ${answerer.id}\n`));
  const snapshot = await refreshWorkspace(runtime, answerer);
  const brief = askBrief(asker, question, await notebook.orientation(), snapshot, await incusEvidenceText(runtime, answerer), rosterText(runtime.declarations, answerer.id));
  const result = await runtime.hire(answerer.id, { role: 'owner', model: answerer.model, directory: answerer.workspace, title: `${answerer.id}: answering ${asker.id}`, brief, schema: Answer });
  for (const [ownerId, kind] of [[asker.id, 'asked'], [answerer.id, 'answered']] as const) {
    const book = runtime.notebook(ownerId);
    await book.journal({ kind, note: `${asker.id} → ${answerer.id}: ${question.slice(0, 300)}`, outcome: result.value.answer.slice(0, 500) });
    await book.commit(`journal ${kind}`).catch(() => undefined);
  }
  return { answerer, answer: result.value, cost: result.cost };
}

export function formatAnswer(answerer: OwnerDeclaration, answer: Answer) {
  const section = (title: string, lines: readonly string[]) => (lines.length ? `\n${title}:\n${lines.map(line => `- ${line}`).join('\n')}` : '');
  return `${who(answerer)} answers:\n${answer.answer}${section('Observed', answer.observed)}${section('Inferred', answer.inferred)}${section('Unknown', answer.unknown)}`;
}
