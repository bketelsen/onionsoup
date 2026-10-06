import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { processRequest } from '../src/brokering.ts';
import { requestWork } from '../src/delegation.ts';
import { steerReportItem } from '../src/org-work.ts';
import { Runtime } from '../src/runtime.ts';
import { withActiveHooks } from './active-hooks.ts';

function proposal(title: string) {
  return { title, goal: `Do ${title}`, rationale: 'Org-wide change', acceptance: ['It works'], size: 'small' as const };
}

async function setup() {
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: await mkdtemp(join(tmpdir(), 'org-work-')) });
  for (const owner of runtime.declarations.owners.values()) await runtime.notebook(owner.id).ensure('# Test charter');
  runtime.hire = async () => { throw new Error('no_hire_permitted'); };
  return runtime;
}

/** Odrade's request to one of her reports, accepted without a hire; returns its work item. */
async function requested(runtime: Runtime, to: string, title: string) {
  const request = await requestWork(runtime, 'odrade', to, proposal(title));
  await processRequest(runtime, request.id);
  return { requestId: request.id, itemId: (await runtime.requests.get(request.id)).workItem! };
}

async function journalOf(runtime: Runtime, ownerId: string) {
  const directory = join(runtime.notebook(ownerId).directory, 'journal');
  const files = (await readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.jsonl'));
  const lines = (await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')))).join('').split('\n').filter(Boolean);
  return lines.map(line => JSON.parse(line) as { kind: string; note?: string });
}

test('a manager fans work out to her reports and cancelling one ends only that request', async () => {
  const runtime = await setup();
  const core = await requested(runtime, 'clippy', 'Core change');
  const wiki = await requested(runtime, 'bellonda', 'Wiki follow-up');
  await assert.rejects(steerReportItem(runtime, 'odrade', core.itemId, 'cancel', ' '), /steer_note_required/);
  assert.equal(await steerReportItem(runtime, 'odrade', core.itemId, 'cancel', 'Not needed after all'), 'cancelled');
  await processRequest(runtime, core.requestId);
  await processRequest(runtime, wiki.requestId);
  assert.equal((await runtime.requests.get(core.requestId)).status, 'failed');
  assert.equal((await runtime.requests.get(wiki.requestId)).status, 'work-running');
  assert.equal((await runtime.ledger.get(wiki.itemId)).status, 'planning');
  assert.ok((await journalOf(runtime, 'clippy')).some(entry => entry.kind === 'steered' && entry.note?.includes('cancel by odrade')));
});

test('a manager leaves a note on work she requested, and steers nothing else', async () => {
  const runtime = await setup();
  const core = await requested(runtime, 'clippy', 'Core change');
  assert.equal(await steerReportItem(runtime, 'odrade', core.itemId, 'note', 'Keep it small'), 'queued to its work session');
  assert.ok((await journalOf(runtime, 'clippy')).some(entry => entry.kind === 'manager-note' && entry.note === 'from odrade: Keep it small'));
  assert.ok((await journalOf(runtime, 'odrade')).some(entry => entry.kind === 'steered'));
  const peerRequest = await runtime.requests.open('homelab', 'clippy', { kind: 'work', purpose: 'Peer ask', proposal: proposal('Peer ask') }, 'none');
  const peerAsked = await runtime.ledger.create('clippy', 'owner-change', proposal('Peer ask'), { request: peerRequest.id });
  const unrequested = await runtime.ledger.create('clippy', 'owner-change', proposal('Unrequested'));
  const peerWork = await runtime.ledger.create('homelab', 'owner-change', proposal('Fleet change'));
  await assert.rejects(steerReportItem(runtime, 'odrade', peerAsked.id, 'cancel', 'x'), /not_your_report_item/);
  await assert.rejects(steerReportItem(runtime, 'odrade', unrequested.id, 'cancel', 'x'), /not_your_report_item/);
  await assert.rejects(steerReportItem(runtime, 'odrade', peerWork.id, 'note', 'x'), /not_your_report_item/);
  await assert.rejects(steerReportItem(runtime, 'homelab', core.itemId, 'note', 'x'), /not_your_report_item/);
});

test('in chat, a manager reads all her reports\' work and there is no initiative or raise tool', async () => {
  const runtime = await setup();
  const core = await requested(runtime, 'clippy', 'Core change');
  const input = new Proxy({} as Parameters<typeof withActiveHooks>[0], {
    get(_target, key) { throw new Error(`unexpected_plugin_input: ${String(key)}`); },
  });
  const hooks = await withActiveHooks(input, { declarations: 'packages/owners/test/fixtures/owners', state: runtime.stateDirectory });
  const context = (agent: string) => ({ agent, sessionID: `ses_${agent}`, messageID: 'msg_1', directory: '/chat', worktree: '/chat', abort: new AbortController().signal, metadata: () => {}, ask: async () => {} });
  const tools = hooks.tool!;
  assert.equal(tools.onionsoup_initiative, undefined);
  assert.equal(tools.onionsoup_raise, undefined);
  assert.match(String(await tools.onionsoup_status!.execute({ item: core.itemId }, context('Odrade'))), new RegExp(`^${core.itemId}: Core change`));
  assert.match(String(await tools.onionsoup_status!.execute({ item: core.itemId }, context('Bellonda'))), /^No work item/);
  const oneOff = await runtime.ledger.create('clippy', 'owner-change', proposal('One-off fix'));
  const summary = String(await tools.onionsoup_status!.execute({}, context('Odrade')));
  assert.ok(summary.includes("Your reports' work"), summary);
  assert.ok(summary.includes(`- clippy: work ${oneOff.id}: `) && summary.includes(`- clippy: work ${core.itemId}: `), summary);
  assert.doesNotMatch(String(await tools.onionsoup_status!.execute({}, context('Bellonda'))), /Your reports' work/);
});
