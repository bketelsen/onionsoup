import assert from 'node:assert/strict';
import { mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { OperatorApplications } from '../src/operator-application-host.ts';
import { buildOperatorHandoff, operatorHandoffSourceDigest } from '../src/operator-handoff-artifact.ts';
import { OperatorHandoffs } from '../src/operator-handoff-host.ts';
import { acceptHandoffChildren, setupHandoffFixture } from './operator-handoff-fixture.ts';

const SETTLE_MS = 120_000;
async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await delay(25);
  }
  assert.fail('symlink fixture operation did not settle');
}

test('instruction aliases survive real child checks, combined checks and approved application', async () => {
  const setup = await setupHandoffFixture();
  await mkdir(join(setup.directory, '.agents/skills/review'), { recursive: true });
  await mkdir(join(setup.directory, '.claude'));
  await mkdir(join(setup.directory, '.gemini'));
  await writeFile(join(setup.directory, 'AGENTS.md'), 'Canonical instructions\n');
  await writeFile(join(setup.directory, '.agents/skills/review/SKILL.md'), 'Review instructions\n');
  const aliases = [['CLAUDE.md', 'AGENTS.md'], ['GEMINI.md', 'AGENTS.md'],
    ['.claude/skills', '../.agents/skills'], ['.gemini/skills', '../.agents/skills']];
  for (const [path, target] of aliases) await symlink(target!, join(setup.directory, path!));
  const checkPath = join(setup.directory, 'combined.test.mjs');
  await writeFile(checkPath, `${await readFile(checkPath, 'utf8')}
import { readFileSync, readlinkSync } from 'node:fs';
assert.equal(readlinkSync('CLAUDE.md'), 'AGENTS.md');
assert.equal(readFileSync('.claude/skills/review/SKILL.md', 'utf8'), 'Review instructions\\n');
`);
  await setup.git(['add', '.']);
  await setup.git(['commit', '-qm', 'repository instruction aliases']);
  setup.head = (await setup.git(['rev-parse', 'HEAD'])).stdout.trim();
  await setup.git(['-C', setup.second, 'reset', '--hard', setup.head]);
  const target = join(setup.workspace, 'integration');
  await setup.git(['worktree', 'add', '-q', '--detach', target, setup.head]);
  const context = await acceptHandoffChildren(setup);
  const job = await context.jobs.get(context.origin, context.id);
  const built = await buildOperatorHandoff(job);
  assert.equal(built.artifact.sourceDigest, operatorHandoffSourceDigest(built.source));
  for (const [path, target] of aliases) {
    const entry = built.source.find(file => file.path === path)!;
    assert.equal(entry.mode, 0o120000);
    assert.equal(entry.content.toString(), target);
  }
  const handoffs = new OperatorHandoffs(context.jobs, context.client, context.writes);
  const prepared = await handoffs.prepare(context.origin, context.id, context.parent());
  for (const check of prepared.artifact.checks) {
    await handoffs.check(context.origin, context.id, prepared.artifact.digest, check.id, context.parent());
  }
  await waitFor(() => handoffs.show(context.origin, context.id), report => report.status === 'ready');
  const applications = new OperatorApplications(handoffs, context.permissions);
  const preview = await applications.preview(context.origin, context.id, target);
  await applications.apply(context.origin, context.id, target, preview.digest, context.parent());
  const applied = await waitFor(() => applications.show(context.origin, context.id), report => report.status === 'applied');
  assert.equal(applied.result!.sourceDigest, built.artifact.sourceDigest);
  assert.equal(await readFile(join(target, 'a.mjs'), 'utf8'), 'export default 1;\n');
  assert.equal(await readFile(join(target, 'b.mjs'), 'utf8'), 'export default 2;\n');
  for (const [path, linkTarget] of aliases) assert.equal(await readlink(join(target, path!)), linkTarget);
  assert.equal((await setup.git(['-C', target, 'rev-parse', 'HEAD'])).stdout.trim(), setup.head);
  assert.equal((await setup.git(['-C', target, 'diff', '--cached'])).stdout, '');
});
