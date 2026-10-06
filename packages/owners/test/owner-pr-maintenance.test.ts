import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Config, Plugin } from '@opencode-ai/plugin';
import { Runtime } from '../src/runtime.ts';
import { updateOwnerPullRequests } from '../src/owner-pr-maintenance.ts';
import { git } from '../src/workspace.ts';
import { withActiveHooks } from './active-hooks.ts';

const proposal = { title: 'Approved PR', goal: 'Preserve the approved feature', rationale: 'Regression', acceptance: ['Feature preserved'], size: 'small' as const };
const url = 'https://github.com/example/clippy/pull/1';

async function repository(root: string) {
  const remote = join(root, 'origin');
  await mkdir(remote);
  await git(remote, ['init', '-q', '--bare', '--initial-branch=main']);
  const seed = join(root, 'seed');
  await git(root, ['clone', '-q', remote, seed]);
  await git(seed, ['config', 'user.name', 'Fixture']);
  await git(seed, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(seed, 'base'), 'base\n');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-qm', 'Initial base']);
  await git(seed, ['push', '-q', 'origin', 'main']);
  await git(seed, ['checkout', '-qb', 'original']);
  await writeFile(join(seed, 'feature'), 'approved feature\n');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-qm', 'Approved feature']);
  await git(seed, ['push', '-q', 'origin', 'original']);
  const head = (await git(seed, ['rev-parse', 'HEAD'])).trim();
  await git(seed, ['checkout', '-q', 'main']);
  await writeFile(join(seed, 'base-update'), 'new base\n');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-qm', 'New base']);
  await git(seed, ['push', '-q', 'origin', 'main']);
  return { remote, head };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'owner-pr-maintenance-'));
  const declarations = join(root, 'config');
  await cp('packages/owners/test/fixtures/owners', declarations, { recursive: true });
  const { remote, head } = await repository(root);
  const workspace = join(root, 'checkout');
  await git(root, ['clone', '-q', remote, workspace]);
  await git(workspace, ['config', 'user.name', 'Fixture']);
  await git(workspace, ['config', 'user.email', 'fixture@example.invalid']);
  const declaration = join(declarations, 'owners', 'clippy.yaml');
  const original = await readFile(declaration, 'utf8');
  await writeFile(declaration, original.replace('https://example.invalid/clippy.git', remote)
    .replace('verify: [[go, test, ./...]]', 'verify: [[sh, -c, "test -f feature && test -f base-update"]]')
    + `workspace: ${JSON.stringify(workspace)}\n`);
  const state = join(root, 'state');
  const runtime = await Runtime.open({ declarations, state });
  const source = await runtime.ledger.create('clippy', 'desk-publication', proposal, {
    status: 'landed', branch: 'original', landedCommit: head,
    publication: { url, branch: 'original', by: 'person', at: new Date().toISOString(), state: 'open' },
  });
  return { root, declarations, state, runtime, remote, head, source };
}

/** A gh that reports the PR as mergeable with `mergeStateStatus` (BEHIND only under required-up-to-date protection). */
async function fakeGithub(root: string, remote: string, operation: () => Promise<void>, mergeStateStatus = 'BEHIND') {
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'package.json'), '{"type":"commonjs"}');
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] !== 'pr') throw new Error('unexpected fixture API');
if (args[1] === 'checks') {
  console.log('[]');
} else {
  const head = execFileSync('git', ['-C', ${JSON.stringify(remote)}, 'rev-parse', 'original']).toString().trim();
  console.log(JSON.stringify({ url: ${JSON.stringify(url)}, state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: ${JSON.stringify(mergeStateStatus)}, headRefOid: head }));
}
`, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    await operation();
  } finally {
    process.env.PATH = previous;
  }
}

async function toolFixture() {
  const context = await fixture();
  const directory = join(context.root, 'chat');
  await mkdir(directory);
  const client = { session: { get: async ({ path }: { path: { id: string } }) => ({
    data: { id: path.id, directory, title: 'Owner maintenance', time: { created: 1, updated: 1 } },
  }) } };
  const hooks = await withActiveHooks({ client } as unknown as Parameters<Plugin>[0], {
    declarations: context.declarations, state: context.state,
  });
  const toolContext = {
    agent: 'Clippy', sessionID: 'ses_owner', messageID: 'msg_update', directory, worktree: directory,
    abort: new AbortController().signal, metadata: () => {}, ask: async () => { throw new Error('clean_update_must_not_ask'); },
  };
  return { ...context, hooks, toolContext };
}

test('only configured maintain-prs owners receive the update tool, whose only argument is refresh, and its guide', async () => {
  const { hooks } = await toolFixture();
  const config: Config = {};
  await hooks.config!(config);
  const clippyPermission = config.agent!['Clippy']!.permission as Record<string, unknown>;
  const homelabPermission = config.agent!['Miles Teg']!.permission as Record<string, unknown>;
  const defaultPermission = config.permission as Record<string, unknown>;
  assert.deepEqual(Object.keys(hooks.tool!.onionsoup_update_prs!.args), ['refresh']);
  assert.equal(clippyPermission.onionsoup_update_prs, 'allow');
  assert.notEqual(homelabPermission.onionsoup_update_prs, 'allow');
  assert.equal(defaultPermission.onionsoup_update_prs, 'deny');
  assert.match(config.agent!['Clippy']!.prompt!, /onionsoup_update_prs runs your configured maintain-prs duty/);
  assert.match(config.agent!['Clippy']!.prompt!, /refresh: true brings a stale PR up to date with its base now/);
  assert.doesNotMatch(config.agent!['Miles Teg']!.prompt!, /onionsoup_update_prs/);
});

test('a mergeable PR behind its base is left by the duty and brought up to date by refresh, without a person gate', async () => {
  const { hooks, runtime, root, remote, head, source, toolContext } = await toolFixture();
  await fakeGithub(root, remote, async () => {
    const duty = await updateOwnerPullRequests(runtime, 'clippy');
    assert.deepEqual(duty.updates, [], JSON.stringify(duty));
    assert.match(duty.summary, /pull\/1 clean/);
    assert.equal((await git(remote, ['rev-parse', 'original'])).trim(), head, 'the duty does not touch a mergeable PR');

    const response = await hooks.tool!.onionsoup_update_prs!.execute({ refresh: true }, toolContext as never);
    assert.ok(typeof response === 'string');
    const report = JSON.parse(response) as { summary: string; updates: { id: string; status: string }[] };
    assert.match(report.summary, /behind its base \(refresh requested\)/);
    assert.equal(report.updates.length, 1, response);
    assert.equal(report.updates[0]?.status, 'landed', response);
    const updated = await runtime.ledger.get(report.updates[0]!.id);
    assert.equal(updated.rebaseOf?.itemId, source.id);
    assert.equal(updated.rebaseOf?.mode, 'update-base');
    assert.equal(updated.implementations[0]?.verification[0]?.exitCode, 0);
    assert.deepEqual(updated.humanNotes, []);
    const published = (await git(remote, ['rev-parse', 'original'])).trim();
    await git(remote, ['merge-base', '--is-ancestor', head, published]);
    await git(remote, ['merge-base', '--is-ancestor', 'main', published]);

    const again = await updateOwnerPullRequests(runtime, 'clippy', { refresh: true });
    assert.deepEqual(again.updates, [], 'a PR that already holds the base tip is not refreshed again');
  }, 'CLEAN');
});

test('the public owner tool advances a real behind PR with host verification and cannot select a foreign owner or head', async () => {
  const { hooks, runtime, root, remote, head, source, toolContext, state } = await toolFixture();
  const foreign = await runtime.ledger.create('homelab', 'desk-publication', proposal, {
    status: 'landed', landedCommit: 'foreign-head',
    publication: { url: 'https://github.com/example/fleet/pull/9', branch: 'foreign', by: 'person', at: '', state: 'open' },
  });
  await fakeGithub(root, remote, async () => {
    const response = await hooks.tool!.onionsoup_update_prs!.execute({
      owner: 'homelab', repository: 'example/fleet', branch: 'foreign', head: 'arbitrary',
    } as never, toolContext as never);
    assert.ok(typeof response === 'string');
    const report = JSON.parse(response) as { updates: { id: string; status: string }[] };
    assert.equal(report.updates[0]?.status, 'landed', response);
    const updated = await runtime.ledger.get(report.updates[0]!.id);
    assert.equal(updated.owner, 'clippy');
    assert.equal(updated.rebaseOf?.itemId, source.id);
    assert.equal(updated.implementations[0]?.verification[0]?.exitCode, 0);
    assert.deepEqual(updated.humanNotes, []);
    const published = (await git(remote, ['rev-parse', 'original'])).trim();
    await git(remote, ['merge-base', '--is-ancestor', head, published]);
    await git(remote, ['merge-base', '--is-ancestor', 'main', published]);
    assert.equal((await git(remote, ['show', 'original:feature'])).trim(), 'approved feature');
    assert.equal((await runtime.ledger.get(foreign.id)).landedCommit, 'foreign-head');
    const dutyRuns = JSON.parse(await readFile(join(state, 'duties.json'), 'utf8')) as Record<string, string>;
    assert.ok(dutyRuns['clippy/prs']);
  });
});

test('manual declared maintenance preserves the independent review and person push gate for a real conflict', async () => {
  const { runtime, root, remote, source } = await fixture();
  const workspace = runtime.owner('clippy').workspace;
  await git(workspace, ['checkout', '-qb', 'original', 'origin/original']);
  await writeFile(join(workspace, 'base'), 'approved branch intent\n');
  await git(workspace, ['commit', '-qam', 'Approved base intent']);
  await git(workspace, ['push', '-q', 'origin', 'original']);
  const originalHead = (await git(workspace, ['rev-parse', 'HEAD'])).trim();
  await runtime.ledger.update(source.id, current => ({ ...current, landedCommit: originalHead }));
  await git(workspace, ['checkout', '-q', 'main']);
  await writeFile(join(workspace, 'base'), 'independent base intent\n');
  await git(workspace, ['commit', '-qam', 'Independent base intent']);
  await git(workspace, ['push', '-q', 'origin', 'main']);
  runtime.hire = async (_owner, request) => {
    const answers: Record<string, () => Promise<unknown>> = {
      owner: async () => ({ decision: 'resolve', guidance: 'Retain both intents', reason: 'Both are needed' }),
      implementer: async () => {
        await writeFile(join(request.directory, 'base'), 'independent base intent\napproved branch intent\n');
        return { summary: 'Both intents retained', filesChanged: ['base'], deviationsFromPlan: [] };
      },
      reviewer: async () => ({ decision: 'approve', summary: 'Both intents retained', findings: [] }),
    };
    const answer = answers[request.role];
    assert.ok(answer, request.role);
    return { value: request.schema.parse(await answer()), sessionID: `ses_${request.role}`,
      cost: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
  };
  await fakeGithub(root, remote, async () => {
    const report = await updateOwnerPullRequests(runtime, 'clippy');
    assert.equal(report.updates[0]?.status, 'awaiting-push-approval', JSON.stringify(report));
    const update = await runtime.ledger.get(report.updates[0]!.id);
    assert.equal(update.rebaseOf?.mode, undefined);
    assert.equal(update.verdicts.at(-1)?.decision, 'approve');
    assert.equal((await git(remote, ['rev-parse', 'original'])).trim(), originalHead);
  });
});

test('missing duty, missing persona and subagent identity cannot gain manual maintenance authority', async () => {
  const { runtime, hooks, toolContext } = await toolFixture();
  await assert.rejects(updateOwnerPullRequests(runtime, 'homelab'), /owner_pr_updates_not_configured/);
  runtime.declarations.owners.set('clippy', { ...runtime.owner('clippy'), persona: undefined });
  await assert.rejects(updateOwnerPullRequests(runtime, 'clippy'), /owner_pr_updates_not_configured/);
  await assert.rejects(hooks.tool!.onionsoup_update_prs!.execute({}, {
    ...toolContext, agent: 'onionsoup-implementer',
  } as never), /not one/);
  assert.equal((await runtime.ledger.list()).length, 1);
});
