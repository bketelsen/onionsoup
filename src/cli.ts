import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IssueSnapshot } from './contracts.ts';
import { fixtureModel } from './fixture-model.ts';
import { liveModel, login, models, providerName } from './providers.ts';
import { triage, type RunRecord } from './triage.ts';

async function save(record: RunRecord) {
  const directory = process.env.ONIONSOUP_RUNS_DIR ?? 'runs';
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${record.runId}.json`);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, target);
}

async function main() {
  const [command, file] = process.argv.slice(2);
  if (command === 'login') return login(providerName(file));
  if (command === 'models') return models();
  if (!['run', 'demo'].includes(command) || !file)
    throw new Error('Usage: triage run <snapshot.json> | demo <snapshot.json> | login copilot|codex | models');
  const input = IssueSnapshot.parse(JSON.parse(await readFile(file, 'utf8')));
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const options = command === 'demo'
    ? { provider: 'fixture', modelId: 'scripted', model: fixtureModel([JSON.parse(await readFile(new URL('../examples/incomplete-assessment.json', import.meta.url), 'utf8'))]) }
    : await liveModel();
  const result = await triage(input, { ...options, signal: controller.signal, checkpoint: save });
  console.log(JSON.stringify(result, null, 2));
  console.error(`Saved ${join(process.env.ONIONSOUP_RUNS_DIR ?? 'runs', `${result.runId}.json`)} (${result.status})`);
  if (result.status === 'failed') process.exitCode = 1;
}

main().catch(error => {
  // Schemas and CLI configuration have useful local diagnostics. Network failures
  // are handled inside AgentLayer and reported as typed run failures.
  console.error(error instanceof Error ? error.message : 'Command failed');
  process.exitCode = 1;
});
