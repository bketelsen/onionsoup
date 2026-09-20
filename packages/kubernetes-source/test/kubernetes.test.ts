import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectKubernetes, kubernetesCommand, kubernetesSshArguments, KubernetesTarget, KubernetesRun, KubernetesEvidence, normalizeKubernetes, type Section } from '../src/index.ts';
const target = { schemaVersion: 1, assetId: 'test-cluster', host: 'example.invalid', user: 'operator' };
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'onionsoup-k3s-')); t.after(() => rm(root, { recursive: true, force: true })); return join(root, 'run');
}
const transcripts: Record<Section, string> = { nodes: 'v1\nn|True\nn|False\nn|\n', pods: 'v1\np|Running|True\np|Succeeded|False\np|Failed|False\np|Future|\n',
  applications: 'v1\na|Healthy|OutOfSync\na|Degraded|Synced\na||\n' };
test('cluster authority pins loopback endpoint, kubeconfig, context and finite get commands; sudo is explicit', () => {
  assert.equal(KubernetesTarget.parse(target).access, 'direct');
  for (const raw of [{ ...target, host: '-oProxyCommand=id' }, { ...target, user: 'a;id' }, { ...target, access: 'sudo -s' },
    { ...target, kubeconfig: '/tmp/other' }, { ...target, command: 'sync' }, { ...target, context: 'other' }]) assert.throws(() => KubernetesTarget.parse(raw));
  for (const section of ['nodes', 'pods', 'applications'] as const) {
    const direct = kubernetesCommand(target, section), sudo = kubernetesCommand({ ...target, access:'sudo' }, section);
    assert.ok(!direct.includes('sudo')); assert.ok(sudo.includes('/usr/bin/sudo -n /usr/bin/k3s kubectl'));
    for (const fixed of ['--kubeconfig=/etc/rancher/k3s/k3s.yaml','--context=default','--server=https://127.0.0.1:6443', '--request-timeout=10s','--cache-dir=/dev/null']) assert.ok(direct.includes(fixed));
    assert.ok(!direct.includes('metadata')); assert.ok(!direct.includes('.spec')); assert.ok(!direct.includes('secrets'));
    const args = kubernetesSshArguments(target, section);
    for (const flag of ['BatchMode=yes','StrictHostKeyChecking=yes','UpdateHostKeys=no','ForwardAgent=no','ForwardX11=no','ClearAllForwardings=yes','PermitLocalCommand=no']) assert.ok(args.includes(flag));
    assert.deepEqual(args.slice(0, 2), ['-F','/dev/null']); assert.equal(args.at(-1), direct);
  }
  assert.throws(() => kubernetesCommand(target, 'secrets' as Section));
});
test('projection keeps readiness, lifecycle, health and drift independent and maps missing/new statuses to unknown', () => {
  assert.deepEqual(normalizeKubernetes('nodes', transcripts.nodes), { section:'nodes',total:3,readiness:{ready:1,notReady:1,unknown:1} });
  assert.deepEqual(normalizeKubernetes('pods', transcripts.pods), { section:'pods',total:4,readiness:{ready:1,notReady:2,unknown:1}, phases:{Pending:0,Running:1,Succeeded:1,Failed:1,Unknown:1} });
  assert.deepEqual(normalizeKubernetes('applications', transcripts.applications), { section:'applications',total:3,
    health:{Healthy:1,Progressing:0,Degraded:1,Suspended:0,Missing:0,Unknown:1},sync:{Synced:1,OutOfSync:1,Unknown:1} });
  for (const section of ['nodes','pods','applications'] as const) assert.equal(normalizeKubernetes(section, 'v1\n').total, 0);
  const evidence = normalizeKubernetes('nodes', transcripts.nodes); assert.throws(() => KubernetesEvidence.parse({ ...evidence, total:0 }));
  for (const text of ['', 'v1\nn|True', 'v1\nn|True|secret\n', 'v1\nn|private text\n', 'v1\np|Running|True\n', 'v1\n'+'n|True\n'.repeat(5001), 'x'.repeat(256*1024+1)])
    assert.throws(() => normalizeKubernetes('nodes',text));
});
test('admission and each query are durable before transport, terminal evidence survives replay', async t => {
  const directory = await fixture(t), calls: Section[] = [];
  const result = await collectKubernetes(target, { directory, transport:async (_, section) => {
    const saved = KubernetesRun.parse(JSON.parse(await readFile(join(directory,'observation.json'),'utf8')));
    assert.equal(saved.status,'running'); assert.equal(saved.queries.find(q => q.section === section)?.status,'running');
    calls.push(section); return { code:0, stdout:transcripts[section] };
  } });
  assert.deepEqual(calls, ['nodes','pods','applications']); assert.equal(result.status,'completed');
  assert.deepEqual(JSON.parse(await readFile(join(directory,'observation.json'),'utf8')),result);
  assert.ok(!JSON.stringify(result).includes(target.host));
  const tampered = structuredClone(result); tampered.queries[0].evidence = result.queries[1].evidence;
  assert.throws(() => KubernetesRun.parse(tampered));
  assert.throws(() => KubernetesRun.parse({ ...result, status:'failed' }));
});
test('missing CLI, denied queries, SSH errors, invalid output and bounds never become empty inventories', async t => {
  for (const [response, failure] of [[{code:69,stdout:'secret'},'cli_unavailable'],[{code:255,stdout:'secret'},'ssh_failed'],
    [{code:1,stdout:'private forbidden/missing CRD'},'query_failed'],[{code:0,stdout:''},'invalid_output'],
    [{code:null,stdout:'secret',failure:'timeout'},'timeout'],[{code:null,stdout:'secret',failure:'output_limit'},'output_limit']] as const) {
    const result = await collectKubernetes(target,{directory:await fixture(t),transport:async(_,section)=>section==='nodes'?{code:0,stdout:'v1\n'}:response});
    assert.equal(result.status,'partial'); assert.equal(result.queries[0].evidence?.total,0);
    assert.equal(result.queries[1].failure,failure); assert.equal(result.queries[1].evidence,undefined);
    assert.ok(!JSON.stringify(result).includes('secret')); assert.ok(!JSON.stringify(result).includes('private'));
  }
  let calls=0;
  const failed=await collectKubernetes(target,{directory:await fixture(t),transport:async()=>{calls++;throw new Error('private');}});
  assert.equal(failed.status,'failed'); assert.equal(calls,3);
});
test('cancellation skips later queries and occupied output refuses all contact', async t => {
  const controller=new AbortController(); let calls=0;
  const result=await collectKubernetes(target,{directory:await fixture(t),signal:controller.signal,transport:async()=>{calls++;controller.abort();return {code:0,stdout:'v1\n'};}});
  assert.equal(calls,1); assert.equal(result.status,'failed'); assert.equal(result.queries[0].failure,'cancelled');
  assert.ok(result.queries.slice(1).every(q=>q.status==='not_attempted'));
  const directory=await fixture(t); await writeFile(directory,'occupied');
  await assert.rejects(collectKubernetes(target,{directory,transport:async()=>{calls++;return {code:0,stdout:'v1\n'};}})); assert.equal(calls,1);
});
