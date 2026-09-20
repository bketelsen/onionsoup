import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectContainerInventory, ContainerTarget, normalizeContainerStates, sshArguments, COMMANDS, type Engine } from '../src/index.ts';
import { runSshProcess } from '../src/process.ts';
const target = { schemaVersion: 1, assetId: 'test-containers', host: 'example.invalid', user: 'operator' };
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'onionsoup-containers-')); t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'observation');
}
test('SSH targets cannot inject options, commands, identities or alternate engine endpoints', () => {
  for (const raw of [{ ...target, host: '-oProxyCommand=id' }, { ...target, host: 'good;id' }, { ...target, user: 'root@elsewhere' },
    { ...target, command: 'id' }, { ...target, identityFile: '/tmp/key' }, { ...target, engines: ['docker','docker'] }, { ...target, sudo: true }])
    assert.throws(() => ContainerTarget.parse(raw));
  const args = sshArguments(target, 'docker');
  for (const flag of ['BatchMode=yes','StrictHostKeyChecking=yes','UpdateHostKeys=no','ForwardAgent=no','ClearAllForwardings=yes','PermitLocalCommand=no']) assert.ok(args.includes(flag));
  assert.deepEqual(args.slice(0,2), ['-F','/dev/null']); assert.equal(args.at(-1), COMMANDS.docker);
  assert.ok(args.at(-1)!.includes('unix:///var/run/docker.sock'));
  assert.ok(COMMANDS.podman.includes('--remote=false')); assert.ok(COMMANDS.incus.includes('--force-local'));
  assert.throws(() => sshArguments({ ...target, engines: ['incus'] }, 'docker'));
});
test('state projection preserves known and unknown states and does not expose arbitrary text', () => {
  assert.deepEqual(normalizeContainerStates('docker', '"running"\n"exited"\n"running"\n'), {
    total: 3, states: [{ state: 'exited', count: 1 }, { state: 'running', count: 2 }] });
  assert.deepEqual(normalizeContainerStates('incus', 'RUNNING\nSTOPPED\nFUTURE_STATE\n'), {
    total: 3, states: [{ state: 'running', count: 1 }, { state: 'stopped', count: 1 }, { state: 'unknown', count: 1 }] });
  assert.deepEqual(normalizeContainerStates('podman',''), { total: 0, states: [] });
  for (const raw of ['not JSON','{"State":"running","secret":"private"}','"running"\n\n"exited"','"a b"'])
    assert.throws(() => normalizeContainerStates('docker', raw));
  assert.throws(() => normalizeContainerStates('incus', 'RUNNING,private-name\n'));
  assert.throws(() => normalizeContainerStates('incus', 'RUNNING\n'.repeat(5001)));
  assert.throws(() => normalizeContainerStates('docker', 'x'.repeat(256*1024+1)));
});
test('inventory persists admission before contact and separates unavailable from empty', async t => {
  const directory = await fixture(t), calls: Engine[] = [];
  const result = await collectContainerInventory(target, { directory, transport: async (_, engine) => {
    const saved = JSON.parse(await readFile(join(directory, 'observation.json'), 'utf8'));
    assert.equal(saved.status, 'running'); assert.equal(saved.queries.find((q:any) => q.engine === engine).status, 'running');
    calls.push(engine); return engine === 'docker' ? { code: 69, stdout: 'private-error' } : { code: 0, stdout: engine === 'incus' ? 'RUNNING\n' : '' };
  } });
  assert.deepEqual(calls, ['docker','podman','incus']); assert.equal(result.status, 'partial');
  assert.equal(result.queries[0].counts, undefined); assert.equal(result.queries[0].failure, 'cli_unavailable');
  assert.equal(result.queries[1].counts?.total, 0); assert.equal(result.queries[2].counts?.total, 1);
  const saved = await readFile(join(directory, 'observation.json'), 'utf8');
  assert.deepEqual(JSON.parse(saved), result); assert.ok(!saved.includes('private-error')); assert.ok(!saved.includes(target.host));
});
test('SSH failures, timeout, malformed output and upstream exceptions remain failures without retry', async t => {
  for (const [response, failure] of [[{code:255,stdout:'private-secret'},'ssh_failed'],[{code:1,stdout:''},'query_failed'],
    [{code:0,stdout:'bad'},'invalid_output'],[{code:null,stdout:'',failure:'timeout'},'timeout']] as const) {
    let calls=0;
    const result = await collectContainerInventory({ ...target, engines:['docker'] }, { directory:await fixture(t), transport:async()=>{calls++;return response;} });
    assert.equal(result.status,'failed'); assert.equal(result.queries[0].failure,failure); assert.equal(calls,1);
    assert.ok(!JSON.stringify(result).includes('private-secret'));
  }
  const result = await collectContainerInventory(target, { directory:await fixture(t), transport:async()=>{throw new Error('private credential');} });
  assert.ok(result.queries.every(q=>q.failure==='query_failed'));
});
test('cancellation stops later admission and storage failure prevents all contact', async t => {
  const controller = new AbortController(); let calls=0;
  const result = await collectContainerInventory(target, { directory:await fixture(t), signal:controller.signal,
    transport:async()=>{calls++;controller.abort();return {code:0,stdout:'"running"\n'};} });
  assert.equal(calls,1); assert.equal(result.queries[0].failure,'cancelled');
  assert.ok(result.queries.slice(1).every(q=>q.status==='not_attempted'));
  const occupied = await fixture(t); await writeFile(occupied,'occupied');
  await assert.rejects(collectContainerInventory(target,{directory:occupied,transport:async()=>{throw new Error('Must not contact');}}));
});
const child = (source: string) => () => spawn(process.execPath, ['-e', source], { stdio:['ignore','pipe','pipe'] });
test('real child process timeout and cancellation terminate collection without retaining partial output', async () => {
  const timed = await runSshProcess([],new AbortController().signal,child('setInterval(()=>{},1000)'),20);
  assert.equal(timed.failure,'timeout'); assert.equal(timed.stdout,'');
  const controller = new AbortController();
  const pending = runSshProcess([],controller.signal,child('setInterval(()=>{},1000)'));
  controller.abort(); assert.equal((await pending).failure,'cancelled');
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await runSshProcess([],aborted.signal,()=>{throw new Error('Must not start');})).failure,'cancelled');
});
test('combined stdout/stderr limit and discarded diagnostics are enforced on a real child', async () => {
  const limited = await runSshProcess([],new AbortController().signal,child("process.stderr.write('x'.repeat(300000));setInterval(()=>{},1000)"));
  assert.equal(limited.failure,'output_limit'); assert.equal(limited.stdout,'');
  const clean = await runSshProcess([],new AbortController().signal,child("process.stderr.write('private-diagnostic');process.stdout.write('ok')"));
  assert.equal(clean.code,0); assert.equal(clean.stdout,'ok');
});
