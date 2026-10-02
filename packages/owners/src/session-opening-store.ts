import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ChatOrigin } from './chat-origin.ts';
import { nextMessageId } from './plan-revision.ts';
import { withRecordLock } from './record-lock.ts';
import { writeHandoffFile } from './operator-handoff-file.ts';

export const SessionOpeningKey = z.object({ entity: z.enum(['owner-item', 'reminder', 'owner-continuation']), id: z.string().min(1),
  owner: z.string().min(1), kind: z.enum(['planning', 'execution', 'reminder', 'continuation']) });
export type SessionOpeningKey = z.infer<typeof SessionOpeningKey>;
const Phase = z.enum(['reserved', 'creating', 'created', 'prompting', 'opened', 'blocked', 'uncertain']);
export const SessionOpening = z.object({ version: z.literal(1), key: SessionOpeningKey, token: z.uuid(),
  messageID: z.string().min(1), phase: Phase, directory: z.string().optional(), origin: ChatOrigin.optional(),
  reason: z.string().optional(), history: z.array(z.object({ phase: Phase, at: z.iso.datetime(), token: z.uuid() })) });
export type SessionOpening = z.infer<typeof SessionOpening>;

/** One durable opening per work-item phase or reminder. Unknown effects never become permission to retry. */
export class SessionOpeningStore {
  constructor(readonly stateDirectory: string) {}
  path(key: SessionOpeningKey) {
    const digest = createHash('sha256').update(JSON.stringify([key.entity, key.id, key.kind])).digest('hex');
    return join(this.stateDirectory, 'session-openings', `${digest}.json`);
  }
  async read(key: SessionOpeningKey) {
    let contents: string;
    try { contents = await readFile(this.path(key), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const record = SessionOpening.parse(JSON.parse(contents));
    if (JSON.stringify(record.key) !== JSON.stringify(SessionOpeningKey.parse(key))) throw new Error('session_opening_identity_conflict');
    return record;
  }
  async list() {
    let names: string[];
    try { names = await readdir(join(this.stateDirectory, 'session-openings')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(async name => {
      const record = SessionOpening.parse(JSON.parse(await readFile(join(this.stateDirectory, 'session-openings', name), 'utf8')));
      if (this.path(record.key) !== join(this.stateDirectory, 'session-openings', name)) throw new Error('session_opening_identity_conflict');
      return record;
    }));
  }
  async reserve(input: SessionOpeningKey) {
    const key = SessionOpeningKey.parse(input);
    return withRecordLock(`${this.path(key)}.lock`, async () => {
      const previous = await this.read(key);
      if (previous && (previous.phase !== 'blocked'
        || previous.history.some(entry => ['creating', 'created', 'prompting', 'opened', 'uncertain'].includes(entry.phase)))) return undefined;
      const token = randomUUID();
      const record: SessionOpening = { version: 1, key, token, messageID: nextMessageId([]), phase: 'reserved',
        history: [...(previous?.history ?? []), { phase: 'reserved', at: new Date().toISOString(), token }] };
      await this.save(record);
      return record;
    });
  }
  async advance(reservation: SessionOpening, phase: z.infer<typeof Phase>, receipt: { directory?: string; origin?: ChatOrigin } = {}) {
    return this.mutate(reservation, current => {
      if (receipt.directory && current.directory && receipt.directory !== current.directory) throw new Error('session_opening_directory_conflict');
      if (receipt.origin && current.origin && JSON.stringify(receipt.origin) !== JSON.stringify(current.origin)) throw new Error('session_opening_origin_conflict');
      Object.assign(current, receipt);
      // A late receipt is retained without reviving a cancelled caller's uncertain opening.
      if (['uncertain', 'blocked'].includes(current.phase) && phase !== 'opened') return;
      current.phase = phase;
      current.history.push({ phase, at: new Date().toISOString(), token: current.token });
    });
  }
  async failed(reservation: SessionOpening) {
    return this.mutate(reservation, current => {
      if (current.phase === 'opened') return;
      current.phase = ['creating', 'created', 'prompting', 'uncertain'].includes(current.phase) ? 'uncertain' : 'blocked';
      current.reason = current.phase === 'uncertain' ? 'session_opening_effect_uncertain' : 'session_opening_stopped_before_create';
      current.history.push({ phase: current.phase, at: new Date().toISOString(), token: current.token });
    });
  }
  private async mutate(reservation: SessionOpening, action: (record: SessionOpening) => void) {
    return withRecordLock(`${this.path(reservation.key)}.lock`, async () => {
      const current = await this.read(reservation.key);
      if (!current || current.token !== reservation.token) throw new Error('session_opening_reservation_changed');
      action(current);
      await this.save(current);
      return current;
    });
  }
  private save(record: SessionOpening) {
    return writeHandoffFile(this.path(record.key), JSON.stringify(SessionOpening.parse(record)) + '\n');
  }
}
