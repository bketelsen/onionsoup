import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Runtime } from '../packages/owners/src/runtime.ts';
import { chatPath } from '../packages/owners/src/chats.ts';
import { listAdmissions } from '../packages/owners/src/deployment-admission.ts';
import { oldSurfaceHealth, recoverNoticeAdmissions } from './recover-notice-admissions.mjs';
import { LEGACY_NOTICE_BUILD } from './notice-admission-probe.mjs';
import { worker } from './deploy-release.mjs';

const NEXT = 'a'.repeat(40);
async function startTime(pid) {
  const bytes = await readFile(`/proc/${pid}/stat`, 'utf8');
  return bytes.slice(bytes.lastIndexOf(') ') + 2).split(' ')[19];
}

async function fixture(context, options = {}) {
  const scratch = await mkdtemp(join(tmpdir(), 'notice-recovery-'));
  const state = join(scratch, 'state');
  const root = join(scratch, 'release');
  const config = resolve('packages/owners/test/fixtures/owners');
  const runtime = await Runtime.open({ state, declarations: config });
  const directory = chatPath(runtime, 'clippy');
  const sessions = ['ses_notice0', 'ses_notice1', 'ses_notice2'];
  const old = options.old ?? LEGACY_NOTICE_BUILD;
  for (const buildId of [old, NEXT]) {
    const folder = join(root, 'releases', buildId, 'packages/surface');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'release-manifest.json'), JSON.stringify({ buildId }));
  }
  await symlink(join(root, 'releases', old), join(root, 'current'));
  const deploy = join(state, 'deploy');
  await mkdir(join(deploy, 'leases'), { recursive: true });
  await writeFile(join(deploy, 'pending.json'), JSON.stringify({ status: 'armed', targetBuildId: NEXT }));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let endpoint = { instanceId: randomUUID(), surfacePid: process.pid, surfaceStartTime: await startTime(process.pid),
    opencodePid: child.pid, opencodeStartTime: await startTime(child.pid), url: 'http://127.0.0.1:14567/',
    username: 'opencode', password: 'fixture-secret-that-must-never-appear' };
  const messages = new Map();
  const noticePaths = [];
  const leasePaths = [];
  const delivered = join(state, 'notices/exchanges/delivered');
  await mkdir(delivered, { recursive: true });
  for (const [index, sessionID] of sessions.entries()) {
    const lease = { id: randomUUID(), kind: `chat:${sessionID}`, pid: child.pid, startTime: endpoint.opencodeStartTime };
    const leasePath = join(deploy, 'leases', `${lease.id}.json`);
    leasePaths.push(leasePath);
    await writeFile(leasePath, JSON.stringify(lease));
    const id = `msg_${String(index).padStart(32, '0')}`;
    const text = `[onionsoup notice] Owner exchange (${id})\nRecorded status\n\nFull exchange record: ${delivered}/${id}.json\nWhile delivery is pending: ${state}/notices/exchanges/pending/${id}.json`;
    const notice = { id, owner: 'clippy', text: 'Recorded status', at: '2026-01-01T00:00:00.000Z',
      target: { sessionID, directory }, ...(options.legacy ? {} : { delivery: { agent: 'Clippy', text } }) };
    const path = join(delivered, `${id}.json`);
    noticePaths.push(path);
    await writeFile(path, JSON.stringify(notice));
    messages.set(sessionID, [
      { info: { id: `human${index}`, role: 'user', agent: 'Clippy', time: { created: 1 } }, parts: [{ type: 'text', text: 'Real task' }] },
      { info: { id: `final${index}`, role: 'assistant', parentID: `human${index}`, finish: 'stop', time: { completed: 2 } }, parts: [{ type: 'text', text: 'Completed' }] },
      { info: { id, role: 'user', agent: 'Clippy', time: { created: 3 } }, parts: [{ type: 'text', text }] },
    ]);
  }
  const flags = { busy: false, permission: false, question: false, independent: false, children: false,
    parent: false, restartFailure: false, healthFailure: false, changeAfterDrain: false, endpointChange: false };
  const restarts = [];
  async function replaceEndpoint() {
    child.kill('SIGTERM');
    await exited;
    endpoint = { ...endpoint, instanceId: randomUUID(), opencodePid: process.pid,
      opencodeStartTime: await startTime(process.pid) };
  }
  const input = { root, state, config, surfaceUrl: 'http://127.0.0.1:14568/', expectedOld: old,
    expectedTarget: NEXT, sessions, approvedBy: 'fixture-person', limits: { readinessMs: 0, readinessIntervalMs: 1 },
    effects: {
      health: async () => { if (flags.healthFailure) throw new Error('fixture-health-failed'); },
      systemctl: async (action, unit) => {
        if (action === 'is-active') return true;
        restarts.push(unit);
        if (flags.restartFailure) throw new Error('fixture-restart-failed');
        await replaceEndpoint();
        return true;
      },
    },
    admissionEffects: {
      endpoint: async () => endpoint,
      processes: async () => flags.independent,
      sleep: async () => {
        if (flags.endpointChange) endpoint = { ...endpoint, instanceId: randomUUID() };
        if (flags.changeAfterDrain && JSON.parse(await readFile(join(deploy, 'pending.json'))).status === 'draining') {
          flags.question = true;
        }
      },
      request: async (_endpoint, path, scope) => {
        if (path === '/session/status') return flags.busy ? { [sessions[0]]: { type: 'busy' } } : {};
        if (path === '/permission') return flags.permission ? [{ id: 'permission' }] : [];
        if (path === '/question') return flags.question ? [{ id: 'question' }] : [];
        if (path === '/session') return scope === directory ? sessions.map(id => ({ id, directory,
          ...(flags.parent ? { parentID: 'ses_parent' } : {}) })) : [];
        const session = sessions.find(id => path === `/session/${id}/message`);
        if (session) return structuredClone(messages.get(session));
        if (path.endsWith('/children')) return flags.children ? [{ id: 'ses_child', parentID: sessions[0], directory }] : [];
        throw new Error('unexpected fixture request');
      },
    },
  };
  context.after(async () => { child.kill('SIGTERM'); await exited; runtime.close(); await rm(scratch, { recursive: true, force: true }); });
  return { input, state, root, runtime, messages, flags, restarts, leasePaths, noticePaths, deploy, replaceEndpoint,
    pending: async () => JSON.parse(await readFile(join(deploy, 'pending.json'), 'utf8')) };
}

async function previewAndApprove(state) {
  const preview = await recoverNoticeAdmissions(state.input);
  return { preview, apply: { ...state.input, approveDigest: preview.digest } };
}

test('exact notice preview and approval restart only old surface, retain history/leases and leave drain for worker', async context => {
  const state = await fixture(context);
  const noticeBytes = await Promise.all(state.noticePaths.map(path => readFile(path, 'utf8')));
  const leaseBytes = await Promise.all(state.leasePaths.map(path => readFile(path, 'utf8')));
  const transcript = JSON.stringify([...state.messages]);
  const { preview, apply } = await previewAndApprove(state);
  assert.equal(preview.proof.sessions.length, 3);
  assert.equal((await state.pending()).status, 'armed');
  assert.equal(state.restarts.length, 0);
  assert.doesNotMatch(JSON.stringify(preview), /fixture-secret|Real task|Recorded status/);
  const [receipt, concurrent] = await Promise.all([recoverNoticeAdmissions(apply), recoverNoticeAdmissions(apply)]);
  assert.deepEqual(receipt, concurrent);
  assert.equal(receipt.state, 'completed');
  assert.deepEqual(state.restarts, ['onionsoup-surface.service']);
  assert.deepEqual(await recoverNoticeAdmissions(apply), receipt);
  assert.equal((await state.pending()).status, 'draining');
  assert.equal((await listAdmissions(state.state)).length, 3);
  assert.ok((await listAdmissions(state.state)).every(lease => !lease.alive));
  assert.deepEqual(await Promise.all(state.leasePaths.map(path => readFile(path, 'utf8'))), leaseBytes);
  assert.deepEqual(await Promise.all(state.noticePaths.map(path => readFile(path, 'utf8'))), noticeBytes);
  assert.equal(JSON.stringify([...state.messages]), transcript);
  await assert.rejects(readFile(join(state.deploy, 'rollback.json')), { code: 'ENOENT' });
});

test('legacy delivered notices are eligible only at the explicitly pinned old build', async context => {
  const valid = await fixture(context, { legacy: true });
  assert.equal((await recoverNoticeAdmissions(valid.input)).state, 'preview');
  const other = await fixture(context, { legacy: true, old: 'c'.repeat(40) });
  await assert.rejects(recoverNoticeAdmissions(other.input), /tail_not_notice/);
});

for (const flag of ['busy', 'permission', 'question', 'independent', 'children', 'parent', 'endpointChange']) {
  test(`${flag} refuses notice recovery before any restart or drain`, async context => {
    const state = await fixture(context);
    state.flags[flag] = true;
    await assert.rejects(recoverNoticeAdmissions(state.input));
    assert.equal(state.restarts.length, 0);
    assert.equal((await state.pending()).status, 'armed');
  });
}

for (const change of ['genuine-user', 'wrong-final-parent', 'unfinished', 'wrong-text', 'wrong-agent', 'missing-receipt']) {
  test(`${change} cannot be treated as a completed notice-only tail`, async context => {
    const state = await fixture(context);
    const messages = state.messages.get(state.input.sessions[0]);
    const changes = {
      'genuine-user': () => messages.push({ info: { id: 'human-new', role: 'user' }, parts: [] }),
      'wrong-final-parent': () => { messages[1].info.parentID = 'other-human'; },
      unfinished: () => { messages[1].info.finish = 'tool-calls'; },
      'wrong-text': () => { messages[2].parts[0].text += ' changed'; },
      'wrong-agent': () => { messages[2].info.agent = 'Other'; },
      'missing-receipt': () => rm(state.noticePaths[0]),
    };
    await changes[change]();
    await assert.rejects(recoverNoticeAdmissions(state.input));
    assert.equal(state.restarts.length, 0);
  });
}

test('unknown leases and active ledger work fail closed', async context => {
  const state = await fixture(context);
  const lease = JSON.parse(await readFile(state.leasePaths[0]));
  await writeFile(state.leasePaths[0], JSON.stringify({ ...lease, kind: 'cli-work' }));
  await assert.rejects(recoverNoticeAdmissions(state.input), /unexpected_lease/);
  await writeFile(state.leasePaths[0], JSON.stringify(lease));
  await state.runtime.ledger.create('clippy', 'owner-change', { title: 'Preserve active work', goal: 'Do not interrupt',
    rationale: 'Fixture', size: 'small', acceptance: ['No interruption'] }, { activeRunner: process.pid, status: 'working' });
  await assert.rejects(recoverNoticeAdmissions(state.input), /active_work/);
  assert.equal(state.restarts.length, 0);
});

test('changed approved transcript, receipt, endpoint or selection never silently widens recovery', async context => {
  const state = await fixture(context);
  const { apply } = await previewAndApprove(state);
  const messages = state.messages.get(state.input.sessions[0]);
  messages[1].parts[0].text = 'Changed evidence';
  await assert.rejects(recoverNoticeAdmissions(apply), /evidence_changed/);
  messages[1].parts[0].text = 'Completed';
  const raw = await readFile(state.noticePaths[0], 'utf8');
  await writeFile(state.noticePaths[0], raw + '\n');
  await assert.rejects(recoverNoticeAdmissions(apply), /evidence_changed/);
  await writeFile(state.noticePaths[0], raw);
  await assert.rejects(recoverNoticeAdmissions({ ...apply, sessions: apply.sessions.slice(1) }), /unexpected_lease/);
  assert.equal((await state.pending()).status, 'armed');
  assert.equal(state.restarts.length, 0);
});

test('a pending question appearing after drain reopens admissions without checkpoint or restart', async context => {
  const state = await fixture(context);
  const { apply } = await previewAndApprove(state);
  state.flags.changeAfterDrain = true;
  await assert.rejects(recoverNoticeAdmissions(apply), /not_quiet/);
  assert.equal((await state.pending()).status, 'waiting');
  assert.equal(state.restarts.length, 0);
  await assert.rejects(readFile(join(state.deploy, 'rollback.json')), { code: 'ENOENT' });
});

test('uncertain restart holds an old-worker-compatible checkpoint and never repeats restart on retry', async context => {
  const state = await fixture(context);
  const { apply } = await previewAndApprove(state);
  state.flags.restartFailure = true;
  await assert.rejects(recoverNoticeAdmissions(apply), /gate_held/);
  assert.equal((await state.pending()).status, 'draining');
  const marker = JSON.parse(await readFile(join(state.deploy, 'rollback.json')));
  assert.equal(marker.bootstrap, 'old-surface-restart');
  await assert.rejects(worker(state.input), /bootstrap_old_health_unverified_gate_held/);
  await assert.rejects(recoverNoticeAdmissions(apply));
  assert.equal(state.restarts.length, 1);
  await state.replaceEndpoint();
  const receipt = await recoverNoticeAdmissions(apply);
  assert.equal(receipt.state, 'completed');
  assert.equal(state.restarts.length, 1);
});

test('receipt write failure preserves checkpoint and verified retry finishes without another restart', async context => {
  const state = await fixture(context);
  const { apply } = await previewAndApprove(state);
  const path = join(state.deploy, 'notice-admission-recoveries');
  const restart = state.input.effects.systemctl;
  state.input.effects.systemctl = async (...args) => {
    const result = await restart(...args);
    if (args[0] === 'restart') await writeFile(path, 'fixture obstruction');
    return result;
  };
  await assert.rejects(recoverNoticeAdmissions(apply), /gate_held/);
  assert.equal(state.restarts.length, 1);
  await rm(path);
  assert.equal((await recoverNoticeAdmissions(apply)).state, 'completed');
  assert.equal(state.restarts.length, 1);
});

test('post-restart history changes retain checkpoint instead of claiming successful recovery', async context => {
  const state = await fixture(context);
  const { apply } = await previewAndApprove(state);
  const restart = state.input.effects.systemctl;
  state.input.effects.systemctl = async (...args) => {
    const result = await restart(...args);
    if (args[0] === 'restart') state.messages.get(state.input.sessions[0])[1].parts[0].text = 'new history';
    return result;
  };
  await assert.rejects(recoverNoticeAdmissions(apply), /gate_held/);
  assert.equal(JSON.parse(await readFile(join(state.deploy, 'rollback.json'))).digest, apply.approveDigest);
  assert.equal((await state.pending()).status, 'draining');
});

test('an existing unrelated or partial rollback checkpoint is never removed or overwritten', async context => {
  const state = await fixture(context);
  const { apply } = await previewAndApprove(state);
  for (const bytes of ['{', JSON.stringify({ bootstrap: 'old-surface-restart' })]) {
    await writeFile(join(state.deploy, 'rollback.json'), bytes);
    await assert.rejects(recoverNoticeAdmissions(apply));
    assert.equal(await readFile(join(state.deploy, 'rollback.json'), 'utf8'), bytes);
  }
  assert.equal(state.restarts.length, 0);
});


test('old-build HTTP health rejects false or malformed OpenCode health and redirects', async context => {
  let payload = { healthy: true };
  let redirect = false;
  const opencode = createServer((_request, response) => {
    if (redirect) response.writeHead(302, { location: '/other' });
    response.end(JSON.stringify(payload));
  });
  const surface = createServer((_request, response) => response.end(JSON.stringify({
    deployment: { buildId: LEGACY_NOTICE_BUILD }, opencode: { ok: true },
  })));
  await Promise.all([new Promise(resolve => opencode.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => surface.listen(0, '127.0.0.1', resolve))]);
  context.after(() => { opencode.close(); surface.close(); });
  const endpoint = { url: `http://127.0.0.1:${opencode.address().port}/`, username: 'opencode', password: 'fixture' };
  const selection = { surfaceUrl: `http://127.0.0.1:${surface.address().port}/`, expectedOld: LEGACY_NOTICE_BUILD };
  await oldSurfaceHealth(selection, async () => endpoint);
  for (const invalid of [{ healthy: false }, {}, null, { healthy: 'true' }]) {
    payload = invalid;
    await assert.rejects(oldSurfaceHealth(selection, async () => endpoint), /opencode_unhealthy/);
  }
  redirect = true;
  await assert.rejects(oldSurfaceHealth(selection, async () => endpoint));
});

test('unverified post-restart health retains the marker until a later healthy proof', async context => {
  const state = await fixture(context);
  const { apply } = await previewAndApprove(state);
  const restart = state.input.effects.systemctl;
  state.input.effects.systemctl = async (...args) => {
    const result = await restart(...args);
    if (args[0] === 'restart') state.flags.healthFailure = true;
    return result;
  };
  await assert.rejects(recoverNoticeAdmissions(apply), /gate_held/);
  assert.equal((await state.pending()).status, 'draining');
  assert.equal(JSON.parse(await readFile(join(state.deploy, 'rollback.json'))).digest, apply.approveDigest);
  state.flags.healthFailure = false;
  assert.equal((await recoverNoticeAdmissions(apply)).state, 'completed');
  assert.equal(state.restarts.length, 1);
});


test('same digest resumes an interrupted drain before any restart checkpoint', async context => {
  const state = await fixture(context);
  const { apply } = await previewAndApprove(state);
  await writeFile(join(state.deploy, 'pending.json'), JSON.stringify({ status: 'draining', targetBuildId: NEXT }));
  const receipt = await recoverNoticeAdmissions(apply);
  assert.equal(receipt.state, 'completed');
  assert.deepEqual(state.restarts, ['onionsoup-surface.service']);
  assert.equal((await state.pending()).status, 'draining');
});
