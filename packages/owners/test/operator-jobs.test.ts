import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OperatorJobs, operatorJobDigest } from '../src/operator-jobs.ts';
import { OPERATOR_SUPERVISOR_LIMITS, OperatorSupervisor } from '../src/operator-supervisor.ts';
import { OPERATOR_JOB_LIMITS, type OperatorJobInput, type OperatorSessionSnapshot, type OperatorSupervisorClient } from '../src/operator-jobs-types.ts';

class Sessions implements OperatorSupervisorClient {
  sessions = new Map<string, { title: string; directory: string; snapshot: OperatorSessionSnapshot }>();
  prompts: Array<{ sessionID: string; messageID: string; text: string }> = [];
  aborts: string[] = [];
  createThrowsAfterEffect = false;
  promptThrowsBeforeEffect = false;
  async listSessions(directory: string) {
    return [...this.sessions].filter(([, session]) => session.directory === directory).map(([id, session]) => ({ id, title: session.title }));
  }
  async createSession(directory: string, title: string) {
    const id = `ses_${this.sessions.size + 1}`;
    this.sessions.set(id, { title, directory, snapshot: { status: 'idle', messages: [] } });
    if (this.createThrowsAfterEffect) throw new Error('transport_lost_after_create');
    return { id };
  }
  async readSession(_directory: string, sessionID: string) { return structuredClone(this.sessions.get(sessionID)!.snapshot); }
  async prompt(_directory: string, sessionID: string, messageID: string, text: string) {
    if (this.promptThrowsBeforeEffect) throw new Error('transport_uncertain');
    this.prompts.push({ sessionID, messageID, text });
    const snapshot = this.sessions.get(sessionID)!.snapshot;
    snapshot.messages.push({ id: messageID, role: 'user', text, tools: [] });
    snapshot.status = 'busy';
  }
  async abort(_directory: string, sessionID: string) {
    this.aborts.push(sessionID);
    this.sessions.get(sessionID)!.snapshot.status = 'idle';
  }
  finish(sessionID: string, text = 'Observed src/config.ts:12. This is a research finding, not independent verification.') {
    const snapshot = this.sessions.get(sessionID)!.snapshot;
    const parentID = snapshot.messages.filter(message => message.role === 'user').at(-1)!.id;
    snapshot.messages.push({ id: `msg_final_${sessionID}_${snapshot.messages.length}`, role: 'assistant', parentID, completed: true, text, tools: [
      { callID: `call_${sessionID}`, tool: 'read', status: 'completed' },
    ] });
    snapshot.status = 'idle';
  }
}

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'operator-jobs-'));
  const jobs = new OperatorJobs(workspace, workspace, 'operator');
  const sessions = new Sessions();
  const supervisor = new OperatorSupervisor(jobs, sessions, { ...OPERATOR_SUPERVISOR_LIMITS, receiptGraceMs: 0 });
  const origin = { operator: 'operator', sessionID: 'ses_parent', directory: workspace };
  const intake = { messageID: 'msg_human', text: 'Investigate configuration and tests in parallel. Do not modify files.' };
  const input = (key = 'investigate', count = 2): OperatorJobInput => ({
    key, goal: 'Explain the configuration and its tests', constraints: ['Read only; no owner delegation'],
    tasks: Array.from({ length: count }, (_, index) => ({ id: `child_${index}`, goal: `Investigate slice ${index}`, directory: workspace, access: 'read-only', dependsOn: [] })),
  });
  return { workspace, jobs, sessions, supervisor, origin, intake, input };
}

test('operator jobs retain exact original intake, bind parent and operator, and deduplicate creation', async () => {
  const f = await fixture();
  const job = await f.jobs.create(f.origin, f.intake, f.input());
  assert.deepEqual(await f.jobs.create(f.origin, f.intake, f.input()), job);
  const persisted = JSON.parse(await readFile(f.jobs.path, 'utf8')).jobs[0];
  assert.deepEqual(persisted.intake, f.intake);
  assert.equal(persisted.scope, 'read-only-investigation');
  assert.equal(persisted.goal, f.input().goal);
  await assert.rejects(f.jobs.create(f.origin, f.intake, { ...f.input(), goal: 'Different goal' }), /idempotency_conflict/);
  await assert.rejects(f.jobs.get({ ...f.origin, sessionID: 'ses_other' }, job.id), /origin_mismatch/);
  await assert.rejects(f.jobs.list({ ...f.origin, operator: 'odrade' }), /operator_mismatch/);
});

test('operator jobs reject write scopes, cycles, missing dependencies and symlink workspace escapes', async () => {
  const f = await fixture();
  const writeInput = f.input();
  Object.assign(writeInput.tasks[0]!, { access: 'write' });
  await assert.rejects(f.jobs.create(f.origin, f.intake, writeInput));
  const cyclic = f.input();
  cyclic.tasks[0]!.dependsOn = ['child_1'];
  cyclic.tasks[1]!.dependsOn = ['child_0'];
  await assert.rejects(f.jobs.create(f.origin, f.intake, cyclic), /invalid_dependencies/);
  const missing = f.input();
  missing.tasks[0]!.dependsOn = ['absent'];
  await assert.rejects(f.jobs.create(f.origin, f.intake, missing), /invalid_dependencies/);
  const outside = await mkdtemp(join(tmpdir(), 'outside-operator-'));
  await symlink(outside, join(f.workspace, 'escape'));
  const escaped = f.input();
  escaped.tasks[0]!.directory = join(f.workspace, 'escape');
  await assert.rejects(f.jobs.create(f.origin, f.intake, escaped), /workspace_outside_scope/);
});

test('scheduler runs two independent children globally, keeps parent status responsive and queues additional jobs', async () => {
  const f = await fixture();
  const first = await f.jobs.create(f.origin, f.intake, f.input());
  const second = await f.jobs.create(f.origin, f.intake, f.input('another'));
  await Promise.all([f.supervisor.tick(), f.supervisor.tick()]);
  assert.equal(f.sessions.prompts.length, 2);
  assert.equal((await f.jobs.get(f.origin, first.id)).children.filter(child => child.status === 'running').length, 2);
  assert.equal((await f.jobs.get(f.origin, second.id)).children.filter(child => child.status === 'queued').length, 2);
  f.sessions.finish((await f.jobs.get(f.origin, first.id)).children[0]!.sessionID!);
  await f.supervisor.tick();
  assert.equal(f.sessions.prompts.length, 3);
  assert.equal((await f.jobs.get(f.origin, first.id)).children[0]!.evidence!.tools[0]!.tool, 'read');
});

test('restart adopts exactly one durable creation receipt and never launches a replacement child', async () => {
  const f = await fixture();
  f.sessions.createThrowsAfterEffect = true;
  const job = await f.jobs.create(f.origin, f.intake, f.input('create-crash', 1));
  await f.supervisor.tick();
  const blocked = await f.jobs.get(f.origin, job.id);
  assert.equal(blocked.children[0]!.blocker, 'operator_child_creation_uncertain');
  const restarted = new OperatorSupervisor(new OperatorJobs(f.workspace, f.workspace, 'operator'), f.sessions);
  await restarted.tick();
  const recovered = await f.jobs.get(f.origin, job.id);
  assert.equal(f.sessions.sessions.size, 1);
  assert.equal(recovered.children[0]!.sessionID, 'ses_1');
  assert.equal(recovered.children[0]!.attempts.length, 1);
  assert.equal(f.sessions.prompts.length, 1);
});

test('uncertain dispatch is held, not resent or cancelled as if no work existed', async () => {
  const f = await fixture();
  f.sessions.promptThrowsBeforeEffect = true;
  const job = await f.jobs.create(f.origin, f.intake, f.input('dispatch-crash', 1));
  await f.supervisor.tick();
  await f.supervisor.tick();
  const blocked = await f.jobs.get(f.origin, job.id);
  assert.equal(blocked.children[0]!.attempts.length, 1);
  assert.equal(blocked.children[0]!.blocker, 'operator_child_dispatch_uncertain');
  await assert.rejects(f.supervisor.intervene(f.origin, job.id, 'resume', 'child_0'), /retry_unsafe/);
  await assert.rejects(f.supervisor.intervene(f.origin, job.id, 'cancel'), /turn_changed_or_uncertain/);
  assert.equal(f.sessions.aborts.length, 0);
  assert.equal((await f.jobs.get(f.origin, job.id)).children[0]!.attempts[0]!.endedAt, undefined);
});

test('restart interrupts incomplete turns honestly; explicit resume keeps the same children and immutable attempts', async () => {
  const f = await fixture();
  const job = await f.jobs.create(f.origin, f.intake, f.input());
  await f.supervisor.tick();
  const running = await f.jobs.get(f.origin, job.id);
  for (const child of running.children) f.sessions.sessions.get(child.sessionID!)!.snapshot.status = 'idle';
  const restarted = new OperatorSupervisor(new OperatorJobs(f.workspace, f.workspace, 'operator'), f.sessions, { ...OPERATOR_SUPERVISOR_LIMITS, receiptGraceMs: 0 });
  await restarted.tick();
  const interrupted = await f.jobs.get(f.origin, job.id);
  assert(interrupted.children.every(child => child.blocker === 'operator_child_interrupted'));
  const originalAttempts = interrupted.children.map(child => structuredClone(child.attempts[0]));
  for (const child of interrupted.children) await restarted.intervene(f.origin, job.id, 'resume', child.id);
  await restarted.tick();
  const resumed = await f.jobs.get(f.origin, job.id);
  assert.equal(f.sessions.sessions.size, 2);
  assert.deepEqual(resumed.children.map(child => child.sessionID), running.children.map(child => child.sessionID));
  assert.deepEqual(resumed.children.map(child => child.attempts[0]), originalAttempts);
  assert(resumed.children.every(child => child.attempts.length === 2));
});

test('exact terminal evidence and digest gate synthesis, with no duplicate effects', async () => {
  const f = await fixture();
  const job = await f.jobs.create(f.origin, f.intake, f.input());
  await f.supervisor.tick();
  const running = await f.jobs.get(f.origin, job.id);
  for (const child of running.children) f.sessions.finish(child.sessionID!);
  await f.supervisor.tick();
  const ready = await f.jobs.get(f.origin, job.id);
  assert.equal(ready.status, 'needs-synthesis');
  assert.equal(ready.events.filter(event => event.kind === 'ready').length, 1);
  const ids = ready.children.map(child => child.evidence!.messageID);
  const digest = operatorJobDigest(ready);
  await assert.rejects(f.jobs.synthesize(f.origin, job.id, 'stale', ids, 'summary'), /synthesis_stale/);
  await assert.rejects(f.jobs.synthesize(f.origin, job.id, digest, ['foreign'], 'summary'), /evidence_mismatch/);
  const complete = await f.jobs.synthesize(f.origin, job.id, digest, ids, 'Findings grounded in the recorded child transcripts; not independently verified.');
  assert.equal(complete.status, 'completed');
  assert.deepEqual(await f.jobs.synthesize(f.origin, job.id, digest, ids, complete.synthesis!.text), complete);
  await f.supervisor.tick();
  assert.equal(f.sessions.prompts.length, 2);
  assert.equal((await f.jobs.get(f.origin, job.id)).events.filter(event => event.kind === 'synthesized').length, 1);
  assert.deepEqual(complete.intake, f.intake);
});

test('dependency evidence only becomes available after exact predecessor completion; pause does not abort work', async () => {
  const f = await fixture();
  const input = f.input();
  input.tasks[1]!.dependsOn = ['child_0'];
  const job = await f.jobs.create(f.origin, f.intake, input);
  await f.supervisor.tick();
  assert.equal(f.sessions.prompts.length, 1);
  await f.supervisor.intervene(f.origin, job.id, 'pause');
  f.sessions.finish('ses_1');
  await f.supervisor.tick();
  assert.equal(f.sessions.prompts.length, 1);
  assert.equal(f.sessions.aborts.length, 0);
  await f.supervisor.intervene(f.origin, job.id, 'resume');
  await f.supervisor.tick();
  assert.equal(f.sessions.prompts.length, 2);
  assert.match(f.sessions.prompts[1]!.text, /src\/config.ts:12/);
});

test('later genuine child work is never aborted, retried or treated as this job completion', async () => {
  const f = await fixture();
  const job = await f.jobs.create(f.origin, f.intake, f.input('foreign', 1));
  await f.supervisor.tick();
  const snapshot = f.sessions.sessions.get('ses_1')!.snapshot;
  snapshot.messages.push({ id: 'msg_other_user', role: 'user', text: 'Other real work', tools: [] });
  await f.supervisor.tick();
  assert.equal((await f.jobs.get(f.origin, job.id)).children[0]!.blocker, 'operator_child_foreign_work');
  await assert.rejects(f.supervisor.intervene(f.origin, job.id, 'cancel'), /turn_changed_or_uncertain/);
  assert.equal(f.sessions.aborts.length, 0);
});

test('terminal text with live tools or wrong parent cannot satisfy a job', async () => {
  const f = await fixture();
  const job = await f.jobs.create(f.origin, f.intake, f.input('evidence', 1));
  await f.supervisor.tick();
  f.sessions.finish('ses_1');
  const snapshot = f.sessions.sessions.get('ses_1')!.snapshot;
  snapshot.messages.at(-1)!.tools[0]!.status = 'running';
  await f.supervisor.tick();
  assert.equal((await f.jobs.get(f.origin, job.id)).children[0]!.evidence, undefined);
  snapshot.messages.at(-1)!.tools[0]!.status = 'completed';
  snapshot.messages.at(-1)!.parentID = 'msg_foreign';
  await f.supervisor.tick();
  assert.equal((await f.jobs.get(f.origin, job.id)).children[0]!.evidence, undefined);
});

test('cancel settles only exact child turns, preserves history and remains idempotent', async () => {
  const f = await fixture();
  const job = await f.jobs.create(f.origin, f.intake, f.input('cancel', 1));
  await f.supervisor.tick();
  await assert.rejects(f.supervisor.intervene(f.origin, job.id, 'cancel'), /cancel_pending/);
  assert.equal((await f.jobs.get(f.origin, job.id)).status, 'paused');
  const cancelled = await f.supervisor.intervene(f.origin, job.id, 'cancel');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.children[0]!.sessionID, 'ses_1');
  assert.equal(cancelled.children[0]!.attempts[0]!.reason, 'operator_child_interrupted');
  assert.equal(f.sessions.sessions.get('ses_1')!.snapshot.messages.length, 1);
  assert.deepEqual(await f.supervisor.intervene(f.origin, job.id, 'cancel'), cancelled);
  await f.supervisor.tick();
  assert.equal(f.sessions.prompts.length, 1);
  assert.equal(f.sessions.aborts.length, 1);
});

test('read-only status remains available while a scheduler runtime metadata call is pending', async () => {
  const f = await fixture();
  const job = await f.jobs.create(f.origin, f.intake, f.input('responsive', 1));
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const originalCreate = f.sessions.createSession.bind(f.sessions);
  f.sessions.createSession = async (directory, title) => {
    started();
    await gate;
    return originalCreate(directory, title);
  };
  const tick = f.supervisor.tick();
  await entered;
  try {
    const snapshot = await f.jobs.get(f.origin, job.id);
    assert.equal(snapshot.children[0]!.status, 'creating');
    assert.deepEqual(snapshot.intake, f.intake);
  } finally {
    release();
    await tick;
  }
});

test('a delayed completed turn cannot be retried after interrupted observation', async () => {
  const f = await fixture();
  const job = await f.jobs.create(f.origin, f.intake, f.input('late-result', 1));
  await f.supervisor.tick();
  f.sessions.sessions.get('ses_1')!.snapshot.status = 'idle';
  await f.supervisor.tick();
  f.sessions.finish('ses_1');
  await assert.rejects(f.supervisor.intervene(f.origin, job.id, 'resume', 'child_0'), /retry_new_evidence/);
  assert.equal((await f.jobs.get(f.origin, job.id)).children[0]!.attempts.length, 1);
  await f.supervisor.tick();
  assert.equal((await f.jobs.get(f.origin, job.id)).status, 'needs-synthesis');
});

test('one unavailable child retains its slot and receipt while an independent job uses spare capacity', async () => {
  const f = await fixture();
  const first = await f.jobs.create(f.origin, f.intake, f.input('unavailable', 1));
  await f.supervisor.tick();
  const originalAttempt = (await f.jobs.get(f.origin, first.id)).children[0]!.attempts[0]!;
  const read = f.sessions.readSession.bind(f.sessions);
  f.sessions.readSession = async (directory, sessionID) => {
    if (sessionID === 'ses_1') throw new Error('session_transport_down');
    return read(directory, sessionID);
  };
  const second = await f.jobs.create(f.origin, f.intake, f.input('independent', 2));
  await f.supervisor.tick();
  const unavailable = await f.jobs.get(f.origin, first.id);
  assert.equal(unavailable.children[0]!.blocker, 'operator_child_runtime_unavailable');
  assert.deepEqual(unavailable.children[0]!.attempts[0], originalAttempt);
  assert.equal(unavailable.events.filter(event => event.kind === 'blocked').length, 1);
  const independent = await f.jobs.get(f.origin, second.id);
  assert.equal(independent.children[0]!.status, 'running');
  assert.equal(independent.children[1]!.status, 'queued');
  await f.supervisor.tick();
  assert.equal(f.sessions.prompts.length, 2, 'unknown work still occupies one of the two slots');
  f.sessions.readSession = read;
  await f.supervisor.tick();
  assert.equal((await f.jobs.get(f.origin, first.id)).children[0]!.status, 'running');
});

test('unavailable or ambiguous creation lookup retains its claim and permits only remaining capacity', async () => {
  const f = await fixture();
  f.sessions.createThrowsAfterEffect = true;
  const first = await f.jobs.create(f.origin, f.intake, f.input('creation-unavailable', 1));
  await f.supervisor.tick();
  f.sessions.createThrowsAfterEffect = false;
  const list = f.sessions.listSessions.bind(f.sessions);
  f.sessions.listSessions = async () => { throw new Error('list_unavailable'); };
  const second = await f.jobs.create(f.origin, f.intake, f.input('remaining-capacity', 2));
  await f.supervisor.tick();
  assert.equal((await f.jobs.get(f.origin, first.id)).children[0]!.blocker, 'operator_child_creation_runtime_unavailable');
  assert.equal((await f.jobs.get(f.origin, second.id)).children[1]!.status, 'queued');
  f.sessions.listSessions = async directory => {
    const sessions = await list(directory);
    return [...sessions, { ...sessions[0]!, id: 'ses_duplicate' }];
  };
  await f.supervisor.tick();
  assert.equal((await f.jobs.get(f.origin, first.id)).children[0]!.blocker, 'operator_child_creation_ambiguous');
  assert.equal((await f.jobs.get(f.origin, second.id)).children[1]!.status, 'queued');
  assert.equal(f.sessions.prompts.length, 1);
  f.sessions.listSessions = list;
  await f.supervisor.tick();
  assert.equal(f.sessions.prompts.length, 2);
  assert.equal((await f.jobs.get(f.origin, first.id)).children[0]!.sessionID, 'ses_1');
});

test('creation receipt adoption never dispatches into intervening genuine user work', async () => {
  const f = await fixture();
  f.sessions.createThrowsAfterEffect = true;
  const job = await f.jobs.create(f.origin, f.intake, f.input('adopt-foreign', 1));
  await f.supervisor.tick();
  const snapshot = f.sessions.sessions.get('ses_1')!.snapshot;
  snapshot.messages.push({ id: 'msg_real_user', role: 'user', text: 'A genuine later request', tools: [] });
  f.sessions.finish('ses_1', 'Answer to the genuine user request.');
  const original = structuredClone(snapshot.messages);
  await f.supervisor.tick();
  const blocked = await f.jobs.get(f.origin, job.id);
  assert.equal(blocked.children[0]!.blocker, 'operator_child_foreign_work');
  assert.equal(blocked.children[0]!.attempts.length, 0);
  assert.equal(f.sessions.prompts.length, 0);
  assert.deepEqual(snapshot.messages, original);
});

test('queued resume rechecks changed evidence immediately before dispatch', async () => {
  const f = await fixture();
  const job = await f.jobs.create(f.origin, f.intake, f.input('resume-race', 1));
  await f.supervisor.tick();
  f.sessions.sessions.get('ses_1')!.snapshot.status = 'idle';
  await f.supervisor.tick();
  await f.supervisor.intervene(f.origin, job.id, 'resume', 'child_0');
  f.sessions.finish('ses_1');
  await f.supervisor.tick();
  assert.equal(f.sessions.prompts.length, 1);
  assert.equal((await f.jobs.get(f.origin, job.id)).children[0]!.attempts.length, 1);
  await f.supervisor.tick();
  assert.equal((await f.jobs.get(f.origin, job.id)).status, 'needs-synthesis');
});

test('long child results retain full transcript identity and digest with an explicitly bounded preview', async () => {
  const f = await fixture();
  const job = await f.jobs.create(f.origin, f.intake, f.input('long-result', 1));
  await f.supervisor.tick();
  const fullText = 'Finding at src/example.ts:15. '.repeat(OPERATOR_JOB_LIMITS.textChars);
  f.sessions.finish('ses_1', fullText);
  const next = await f.jobs.create(f.origin, f.intake, f.input('independent-long', 1));
  await f.supervisor.tick();
  const complete = await f.jobs.get(f.origin, job.id);
  const evidence = complete.children[0]!.evidence!;
  assert.equal(complete.status, 'needs-synthesis');
  assert.equal(evidence.truncated, true);
  assert.equal(evidence.originalChars, fullText.length);
  assert.equal(evidence.fullTextDigest, createHash('sha256').update(fullText).digest('hex'));
  assert(evidence.text.length <= OPERATOR_JOB_LIMITS.textChars);
  assert.equal(f.sessions.sessions.get(evidence.sessionID)!.snapshot.messages.find(message => message.id === evidence.messageID)!.text, fullText);
  assert.equal((await f.jobs.get(f.origin, next.id)).children[0]!.status, 'running');
});
