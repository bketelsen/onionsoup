import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPacket, packetMarkdown } from './packet.ts';
import { providerName } from './providers.ts';

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    checkout: { type: 'string' }, commit: { type: 'string' }, output: { type: 'string' },
    readiness: { type: 'string' }, provider: { type: 'string', default: 'copilot' },
  } });
  const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
  if (positionals[0] === 'render' && positionals.length === 2) {
    const directory = resolve(positionals[1]);
    await writeFile(join(directory, 'packet.md'), packetMarkdown(await read(join(directory, 'packet.json'))), { mode: 0o600 });
    console.log(join(directory, 'packet.md')); return;
  }
  if (positionals.length !== 1 || !values.checkout || !values.commit) throw new Error('Usage: packet SNAPSHOT.json --checkout PATH --commit FULL_SHA [--readiness RUN.json] [--output NEW_DIRECTORY] [--provider copilot|codex]\npacket render DIRECTORY');
  const root = resolve('runs/packets');
  if (!values.output) await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = resolve(values.output ?? join(root, randomUUID()));
  const controller = new AbortController(); const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const p = await createPacket(await read(positionals[0]), { directory, checkout: resolve(values.checkout), commit: values.commit,
      provider: providerName(values.provider), readiness: values.readiness ? await read(values.readiness) : undefined, signal: controller.signal });
    console.log(JSON.stringify({ packetId: p.packetId, status: p.status, location: p.locationDisposition, directory }));
    if (p.status !== 'completed') process.exitCode = 1;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Packet failed'); process.exitCode = 1; });
