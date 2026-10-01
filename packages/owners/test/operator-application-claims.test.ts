import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OperatorJobs, operatorJobDigest } from '../src/operator-jobs.ts';
import { OperatorJobLedger, type OperatorApplicationClaimBinding, type OperatorJob } from '../src/operator-jobs-types.ts';
import { operatorApplicationHoldsWorkspace } from '../src/operator-write-state.ts';

const digest = (value: string) => value.repeat(64);

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'operator-application-claims-'));
  const source = join(workspace, 'source');
  const target = join(workspace, 'target');
  const other = join(workspace, 'other');
  await Promise.all([source, target, other].map(directory => mkdir(directory)));
  const jobs = new OperatorJobs(join(workspace, 'state'), workspace, 'operator');
  const origin = { operator: 'operator', sessionID: 'ses_parent', directory: workspace };
  const intake = { messageID: 'msg_original', text: 'Investigate the original scoped goal, then apply only the accepted result.' };
  const sourceJob = await jobs.create(origin, intake, { key: 'source', goal: 'Original goal', constraints: ['Preserve child evidence'],
    tasks: [{ id: 'investigate', goal: 'Original scoped investigation', directory: source, access: 'read-only', dependsOn: [] }] });
  // The fixture supplies a completed source; the seam under test is host reservation and child-intake serialization.
  await jobs.transaction(async (ledger, save) => {
    const job = jobs.bound(ledger, origin, sourceJob.id);
    job.children[0]!.status = 'completed';
    job.status = 'needs-synthesis';
    await save();
  });
  const job = await jobs.get(origin, sourceJob.id);
  function binding(directory = target): OperatorApplicationClaimBinding {
    return { id: `application_${randomUUID()}`, token: randomUUID(), artifactDigest: digest('a'),
      target: { directory, identityDigest: digest('b') }, approvalDigest: digest('c') };
  }
  async function reader(directory = target, key = `reader_${randomUUID()}`) {
    return jobs.create(origin, intake, { key, goal: 'Another scoped investigation', constraints: [],
      tasks: [{ id: 'read', goal: 'Read the target', directory, access: 'read-only', dependsOn: [] }] });
  }
  return { jobs, origin, intake, job, source, target, other, workspace, binding, reader };
}

function originalEvidence(job: OperatorJob) {
  return { origin: job.origin, intake: job.intake, goal: job.goal, constraints: job.constraints,
    children: job.children, synthesis: job.synthesis, status: job.status, digest: operatorJobDigest(job) };
}

test('application claim survives reopening with original goal and child evidence unchanged; exact retry adds nothing', async () => {
  const context = await fixture();
  const binding = context.binding();
  const claim = await context.jobs.reserveApplication(context.origin, context.job.id, context.job.revision, binding);
  assert.equal(operatorApplicationHoldsWorkspace(claim), true);
  const reopened = new OperatorJobs(context.jobs.home, context.workspace, 'operator');
  const reserved = await reopened.get(context.origin, context.job.id);
  assert.deepEqual(originalEvidence(reserved), originalEvidence(context.job));
  assert.equal(reserved.events.at(-1)!.kind, 'application-reserved');
  assert.deepEqual(reserved.applicationClaims, [claim]);
  const beforeRetry = await readFile(context.jobs.path, 'utf8');
  assert.deepEqual(await reopened.reserveApplication(context.origin, context.job.id, context.job.revision, binding), claim);
  assert.equal(await readFile(context.jobs.path, 'utf8'), beforeRetry);
  await assert.rejects(context.reader(), /operator_workspace_conflict/);
});

test('held application refuses nested and ancestor readers while independent workspaces remain available', async () => {
  const context = await fixture();
  await mkdir(join(context.target, 'nested'));
  await context.jobs.reserveApplication(context.origin, context.job.id, context.job.revision, context.binding());
  await assert.rejects(context.reader(join(context.target, 'nested')), /operator_workspace_conflict/);
  await assert.rejects(context.reader(context.workspace), /operator_workspace_conflict/);
  assert.ok(await context.reader(context.other));
});

test('existing read-only and write reservations both refuse an overlapping application destination', async () => {
  for (const access of ['read-only', 'write'] as const) {
    const context = await fixture();
    const reader = await context.reader();
    if (access === 'write') {
      // A preexisting write reservation is sufficient for this resource-claim seam; writer authorization is tested separately.
      await context.jobs.transaction(async (ledger, save) => {
        const child = context.jobs.bound(ledger, context.origin, reader.id).children[0]!;
        child.access = 'write';
        child.files = ['existing.txt'];
        await save();
      });
    }
    await assert.rejects(context.jobs.reserveApplication(context.origin, context.job.id, context.job.revision,
      context.binding()), /operator_workspace_conflict/);
    assert.equal((await context.jobs.get(context.origin, context.job.id)).applicationClaims, undefined);
  }
});

test('concurrent child intake and application reservation serialize to exactly one owner', async () => {
  const context = await fixture();
  const results = await Promise.allSettled([
    context.jobs.reserveApplication(context.origin, context.job.id, context.job.revision, context.binding()),
    context.reader(),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.match(String(rejected?.status === 'rejected' ? rejected.reason : ''), /operator_workspace_conflict/);
  const ledger = OperatorJobLedger.parse(JSON.parse(await readFile(context.jobs.path, 'utf8')));
  const applications = ledger.jobs.flatMap(job => job.applicationClaims ?? []).filter(operatorApplicationHoldsWorkspace);
  const readers = ledger.jobs.filter(job => job.id !== context.job.id);
  assert.equal(applications.length + readers.length, 1);
});

test('two applications on the same destination cannot both claim, including distinct source jobs', async () => {
  const context = await fixture();
  const other = await context.reader(context.other);
  await context.jobs.transaction(async (ledger, save) => {
    const job = context.jobs.bound(ledger, context.origin, other.id);
    job.children[0]!.status = 'completed';
    job.status = 'needs-synthesis';
    await save();
  });
  const results = await Promise.allSettled([
    context.jobs.reserveApplication(context.origin, context.job.id, context.job.revision, context.binding()),
    context.jobs.reserveApplication(context.origin, other.id, other.revision, context.binding()),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const ledger = OperatorJobLedger.parse(JSON.parse(await readFile(context.jobs.path, 'utf8')));
  assert.equal(ledger.jobs.flatMap(job => job.applicationClaims ?? []).length, 1);
});

test('pause, cancel and uncertain host progress never release an application claim', async () => {
  const context = await fixture();
  const binding = context.binding();
  await context.jobs.reserveApplication(context.origin, context.job.id, context.job.revision, binding);
  for (const status of ['paused', 'cancelled', 'blocked'] as const) {
    await context.jobs.transaction(async (ledger, save) => {
      context.jobs.bound(ledger, context.origin, context.job.id).status = status;
      await save();
    });
    const reopened = new OperatorJobs(context.jobs.home, context.workspace, 'operator');
    assert.equal(operatorApplicationHoldsWorkspace((await reopened.get(context.origin, context.job.id)).applicationClaims![0]!), true);
    await assert.rejects(context.reader(), /operator_workspace_conflict/);
  }
});

test('release requires exact token and immutable host evidence; retry never reholds a released destination', async () => {
  const context = await fixture();
  const binding = context.binding();
  await context.jobs.reserveApplication(context.origin, context.job.id, context.job.revision, binding);
  const evidence = { kind: 'applied-verified' as const, evidenceDigest: digest('d') };
  await assert.rejects(context.jobs.releaseApplication(context.origin, context.job.id, binding.id, randomUUID(), evidence), /claim_mismatch/);
  await assert.rejects(context.reader(), /operator_workspace_conflict/);
  const released = await context.jobs.releaseApplication(context.origin, context.job.id, binding.id, binding.token, evidence);
  assert.equal(operatorApplicationHoldsWorkspace(released), false);
  const persisted = await readFile(context.jobs.path, 'utf8');
  assert.deepEqual(await context.jobs.releaseApplication(context.origin, context.job.id, binding.id, binding.token, evidence), released);
  assert.equal(await readFile(context.jobs.path, 'utf8'), persisted);
  await assert.rejects(context.jobs.releaseApplication(context.origin, context.job.id, binding.id, binding.token,
    { kind: 'no-effects', evidenceDigest: digest('e') }), /release_conflict/);
  assert.deepEqual(await context.jobs.reserveApplication(context.origin, context.job.id, context.job.revision, binding), released);
  assert.ok(await context.reader());
  assert.deepEqual(originalEvidence(await context.jobs.get(context.origin, context.job.id)), originalEvidence(context.job));
});

test('proven no-effects release keeps immutable reservation history and permits future work', async () => {
  const context = await fixture();
  const binding = context.binding();
  await context.jobs.reserveApplication(context.origin, context.job.id, context.job.revision, binding);
  await context.jobs.releaseApplication(context.origin, context.job.id, binding.id, binding.token,
    { kind: 'no-effects', evidenceDigest: digest('f') });
  assert.ok(await context.reader());
  const job = await context.jobs.get(context.origin, context.job.id);
  assert.equal(job.applicationClaims!.length, 1);
  assert.equal(job.applicationClaims![0]!.release!.kind, 'no-effects');
  assert.equal(job.events.at(-1)!.kind, 'application-released');
});

test('stale revisions, changed binding, foreign origin and targets outside the configured workspace fail closed', async () => {
  const context = await fixture();
  const binding = context.binding();
  await assert.rejects(context.jobs.reserveApplication(context.origin, context.job.id, context.job.revision + 1, binding), /job_stale/);
  await assert.rejects(context.jobs.reserveApplication({ ...context.origin, sessionID: 'ses_foreign' }, context.job.id,
    context.job.revision, binding), /origin_mismatch/);
  const outside = await mkdtemp(join(tmpdir(), 'operator-application-outside-'));
  const escape = join(context.workspace, 'escape');
  await symlink(outside, escape);
  await assert.rejects(context.jobs.reserveApplication(context.origin, context.job.id, context.job.revision,
    context.binding(escape)), /outside_scope/);
  const alias = join(context.workspace, 'alias');
  await symlink(context.target, alias);
  await assert.rejects(context.jobs.reserveApplication(context.origin, context.job.id, context.job.revision,
    context.binding(alias)), /not_canonical/);
  await context.jobs.reserveApplication(context.origin, context.job.id, context.job.revision, binding);
  await assert.rejects(context.jobs.reserveApplication(context.origin, context.job.id, context.job.revision,
    { ...binding, approvalDigest: digest('d') }), /claim_conflict/);
});

test('legacy jobs preserve digest and serialized shape when no application has been reserved', async () => {
  const context = await fixture();
  const serialized = await readFile(context.jobs.path, 'utf8');
  assert.equal(serialized.includes('applicationClaims'), false);
  const reloaded = await new OperatorJobs(context.jobs.home, context.workspace, 'operator').get(context.origin, context.job.id);
  assert.equal(operatorJobDigest(reloaded), operatorJobDigest(context.job));
  assert.equal(reloaded.applicationClaims, undefined);
});
