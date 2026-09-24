import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Runtime } from './runtime.ts';

const AttentionEvent = z.object({ at: z.string(), kind: z.string(), note: z.string().optional() });
export const Attention = z.object({
  id: z.string(), owner: z.string(), note: z.string(), at: z.string(),
  status: z.enum(['open', 'acknowledged', 'resolved']).default('open'),
  decision: z.object({ by: z.string(), reason: z.string(), at: z.string() }).optional(),
});
export type Attention = z.infer<typeof Attention>;

/** Journal entries remain the source of attention, including entries created before lifecycle support. */
export async function listAttention(runtime: Runtime): Promise<Attention[]> {
  const entries: Attention[] = [];
  for (const owner of runtime.declarations.owners.values()) {
    const directory = join(runtime.notebook(owner.id).directory, 'journal');
    const files = (await readdir(directory).catch(() => [])).filter(name => name.endsWith('.jsonl')).sort();
    for (const file of files) {
      const lines = (await readFile(join(directory, file), 'utf8')).split('\n').filter(Boolean);
      for (const [index, line] of lines.entries()) {
        const event = AttentionEvent.parse(JSON.parse(line));
        if (event.kind !== 'attention') continue;
        const digest = createHash('sha256').update(`${owner.id}/${file}/${index}/${line}`).digest('hex').slice(0, 24);
        const id = `a-${digest}`;
        const recorded = await readFile(join(runtime.stateDirectory, 'attention', `${id}.json`), 'utf8').catch(() => undefined);
        entries.push(recorded ? Attention.parse(JSON.parse(recorded)) : Attention.parse({
          id, owner: owner.id, note: event.note ?? '', at: event.at,
        }));
      }
    }
  }
  return entries;
}

export async function changeAttention(runtime: Runtime, id: string, status: Attention['status'], by: string, reason: string) {
  if (!reason.trim()) throw new Error('attention_reason_required');
  const entry = (await listAttention(runtime)).find(candidate => candidate.id === id);
  if (!entry) throw new Error(`attention_not_found: ${id}`);
  const updated: Attention = { ...entry, status, decision: { by, reason, at: new Date().toISOString() } };
  const directory = join(runtime.stateDirectory, 'attention');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${id}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(updated) + '\n', { mode: 0o600 });
  await rename(temporary, path);
  const notebook = runtime.notebook(entry.owner);
  await notebook.journal({ kind: 'attention-decision', note: `${id}: ${status} by ${by}: ${reason}` });
  await notebook.commit(`attention ${status}`);
  return updated;
}
