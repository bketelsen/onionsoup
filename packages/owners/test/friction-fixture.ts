import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime.ts';
import { reportFriction } from '../src/friction.ts';

export async function frictionFixture() {
  const root = await mkdtemp(join(tmpdir(), 'friction-evidence-'));
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: join(root, 'state') });
  runtime.declarations.root = root;
  await mkdir(join(root, 'charters'));
  await writeFile(join(root, 'charters/clippy.md'), '# Fixture repository owner\n');
  runtime.preflightHire = async () => {};
  const workspace = join(root, 'source');
  await mkdir(workspace);
  runtime.declarations.owners.get('clippy')!.workspace = workspace;
  execFileSync('git', ['init', '-q', '-b', 'main', workspace]);
  await writeFile(join(workspace, 'check.ts'), 'export const check = true;\n');
  execFileSync('git', ['-C', workspace, 'add', '.']);
  function commit(message: string) {
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-q', '--allow-empty', '-m', message]);
    return execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  }
  const first = commit('Original source');
  execFileSync('git', ['-C', workspace, 'update-ref', 'refs/remotes/origin/main', first]);
  await runtime.notebook('clippy').ensure('# Fixture');
  const proposal = { title: 'Repair original condition', goal: 'The original condition is healthy', rationale: 'Recorded incident',
    size: 'small' as const, repository: 'example/clippy', acceptance: ['Host checks pass'] };
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, { status: 'failed',
    session: { sessionID: 'original-session', directory: workspace }, origin: { sessionID: 'original-session', directory: workspace },
    publication: { url: 'https://github.com/example/clippy/pull/32', branch: 'fixture', by: 'host', at: new Date().toISOString(), state: 'open' } });
  const report = await reportFriction(runtime, { owner: 'clippy', origin: { sessionID: 'original-session', directory: workspace },
    input: { summary: 'PR32 original operational incident', expected: 'Healthy original condition', actual: 'Condition still blocked',
      evidence: item.id }, failures: [], model: runtime.owner('clippy').model, commit: first, submissionID: 'first' });
  const policy = { version: 1 as const, owner: 'clippy', repository: 'example/clippy',
    enabledSince: '2020-01-01T00:00:00.000Z', intervalMs: 60_000 };
  await writeFile(join(root, 'friction-triage.json'), JSON.stringify(policy));
  return { runtime, root, workspace, first, commit, proposal, report, item, policy,
    async resolveCondition() {
      await runtime.notebook('clippy').journal({ kind: 'attention-condition', workItem: item.id,
        condition: { key: `fixture-condition:${item.id}`, state: 'resolved' }, note: 'Host observed original condition healthy' });
      return `fixture-condition:${item.id}`;
    },
    async cleanup() { runtime.close(); await rm(root, { recursive: true, force: true }); },
  };
}
