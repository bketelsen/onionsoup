import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The person's surface preferences (owner order), kept by the server so every browser sees the same. */
export interface SurfaceSettings { ownerOrder: string[] }

export class SettingsStore {
  constructor(private readonly file: string) {}

  async read(): Promise<SurfaceSettings> {
    const text = await readFile(this.file, 'utf8').catch(() => '{}');
    const parsed = JSON.parse(text) as Partial<SurfaceSettings>;
    return { ownerOrder: Array.isArray(parsed.ownerOrder) ? parsed.ownerOrder.filter(id => typeof id === 'string') : [] };
  }

  async update(change: Partial<SurfaceSettings>) {
    const next = { ...(await this.read()), ...change };
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify(next, null, 2) + '\n');
    await rename(`${this.file}.tmp`, this.file);
    return next;
  }
}

/** Owners in the person's order; owners not in it yet keep their declaration order after the ordered ones. */
export function ordered<T extends { id: string }>(owners: readonly T[], order: readonly string[]) {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...owners].map((owner, index) => ({ owner, index })).sort((left, right) =>
    (rank.get(left.owner.id) ?? order.length + left.index) - (rank.get(right.owner.id) ?? order.length + right.index)).map(entry => entry.owner);
}
