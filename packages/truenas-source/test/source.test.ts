import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectTrueNasHealth, normalizeTrueNasHealth, assertReadOnlyCatalog, trueNasLaunch, TrueNasTarget } from '../src/index.ts';
const raw = () => ({ summary: { status: 'ok' }, errors: {}, details: { system: { version: '25.10', uptime_seconds: 10, system_serial: 'private-serial' },
  system_state: 'READY', pools: [{ status: 'ONLINE', healthy: true, warning: false, name: 'private-pool' }],
  disks: [{ name: 'sda', serial: 'private-disk' }], alerts: [{ level: 'INFO', dismissed: false, text: 'private-alert', args: { credential: 'private-data' } }] } });
const target = { schemaVersion: 1, assetId: 'test-nas', binary: '/absolute/truenas-mcp', host: 'nas.example.invalid', tlsInsecure: true };
test('normalization retains coverage and observations without raw private NAS details', () => {
  const result = normalizeTrueNasHealth(raw());
  assert.equal(result.disposition, 'no_flags_observed'); assert.equal(result.pools?.count, 1);
  assert.equal(result.disks?.count, 1); assert.equal(result.alerts?.bySeverity.INFO, 1);
  assert.ok(!JSON.stringify(result).includes('private-'));
});
test('unavailable, malformed and unknown values cannot turn into healthy zeros', () => {
  const report: any = raw(); delete report.details.pools; report.errors.pools = 'private-error';
  report.details.disks = [{}]; report.details.alerts = [{ dismissed: true, level: 'UNRECOGNIZED' }];
  const result = normalizeTrueNasHealth(report);
  assert.equal(result.pools, null); assert.equal(result.disks, null); assert.equal(result.coverage.pools, false);
  assert.equal(result.alerts?.bySeverity.unknown, 1); assert.equal(result.disposition, 'unknown');
  const incomplete: any = raw(); incomplete.details.pools = [{}];
  assert.equal(normalizeTrueNasHealth(incomplete).pools?.unknown, 1);
  assert.equal(normalizeTrueNasHealth(incomplete).disposition, 'unknown');
});
test('host derives flags across alert severities even when upstream summary says ok', () => {
  for (const severity of ['ERROR', 'ALERT', 'EMERGENCY', 'CRITICAL', 'WARNING', 'WARN']) {
    const report = raw(); report.details.alerts[0].level = severity; report.details.alerts[0].dismissed = true;
    assert.equal(normalizeTrueNasHealth(report).disposition, 'attention_required');
  }
  const report = raw(); report.details.pools[0].healthy = false;
  assert.equal(normalizeTrueNasHealth(report).disposition, 'attention_required');
});
test('launch forces read-only and scoped TLS while rejecting target/argument/credential substitution', () => {
  const launch = trueNasLaunch(target, 'test-only-api-key');
  assert.ok(launch.args.includes('--enable-writes=false')); assert.ok(launch.args.includes('--tls-insecure=true'));
  assert.equal(launch.env.TRUENAS_ENABLE_WRITES, 'false'); assert.ok(!launch.args.includes('test-only-api-key'));
  assert.ok(trueNasLaunch({ ...target, tlsInsecure: false }, 'key').args.includes('--tls-insecure=false'));
  for (const value of [{ ...target, enableWrites: true }, { ...target, apiKey: 'key' }, { ...target, args: ['--enable-writes'] }, { ...target, binary: 'relative' }])
    assert.throws(() => TrueNasTarget.parse(value));
  assert.throws(() => trueNasLaunch(target, ''));
  for (const tools of [[], [{ name: 'truenas_health_report' }, { name: 'truenas_app_start' }], [{ name: 'truenas_health_report' }, { name: 'future_tool' }]])
    assert.throws(() => assertReadOnlyCatalog(tools));
  assert.throws(() => assertReadOnlyCatalog([{ name: 'truenas_health_report' }], 'page2'));
});
async function fixture(t: TestContext, mode: 'ok' | 'unsafe' | 'error' | 'hang' | 'partial' | 'invalid' = 'ok') {
  const root = await mkdtemp(join(tmpdir(), 'onionsoup-nas-')); t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'fake-mcp'), directory = join(root, 'run'), audit = join(root, 'calls.json');
  const report: any = raw(); if (mode === 'partial') { delete report.details.disks; report.errors.disks = 'private upstream failure'; }
  const source = `#!${process.execPath}
import {McpServer} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'))};
import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import {writeFile,readFile} from 'node:fs/promises';
const admission=JSON.parse(await readFile(${JSON.stringify(join(directory, 'observation.json'))},'utf8'));
if(admission.status!=='running'||!process.argv.includes('--enable-writes=false')||process.env.TRUENAS_ENABLE_WRITES!=='false')process.exit(2);
const server=new McpServer({name:'truenas-mcp',version:'fixture'});
server.registerTool('truenas_health_report',{description:'fixture',inputSchema:{}},async()=>{
 await writeFile(${JSON.stringify(audit)},JSON.stringify({tool:'truenas_health_report'}));
 if(${JSON.stringify(mode)}==='hang')await new Promise(()=>{});
 return {isError:${mode === 'error'},content:[{type:'text',text:${mode === 'error' ? 'process.env.TRUENAS_API_KEY' : JSON.stringify(mode === 'invalid' ? '{malformed' : JSON.stringify(report))}}]};
});
if(${JSON.stringify(mode)}==='unsafe')server.registerTool('truenas_app_start',{inputSchema:{}},async()=>({content:[]}));
process.stderr.write(process.env.TRUENAS_API_KEY);
await server.connect(new StdioServerTransport());
`;
  // Use .mjs because temporary directories do not inherit the repository's module type.
  const executable = binary + '.mjs'; await writeFile(executable, source, { mode: 0o700 });
  return { target: { ...target, binary: executable }, directory, audit };
}
test('real stdio collector saves intent and sanitized evidence, suppressing secret-bearing stderr', async t => {
  const f = await fixture(t), result = await collectTrueNasHealth(f.target, { apiKey: 'test-only-api-key', directory: f.directory });
  assert.equal(result.status, 'completed'); assert.equal(result.evidence?.disposition, 'no_flags_observed');
  const saved = await readFile(join(f.directory, 'observation.json'), 'utf8');
  assert.deepEqual(JSON.parse(saved), result); assert.ok(!saved.includes('test-only-api-key')); assert.ok(!saved.includes('private-'));
  assert.equal(JSON.parse(await readFile(f.audit, 'utf8')).tool, 'truenas_health_report');
  assert.match(result.targetHash, /^[a-f0-9]{64}$/); assert.match(result.binaryHash, /^[a-f0-9]{64}$/);
});
test('unexpected discovered tools stop collection before any call', async t => {
  const f = await fixture(t, 'unsafe'), result = await collectTrueNasHealth(f.target, { apiKey: 'key', directory: f.directory });
  assert.equal(result.status, 'failed'); assert.equal(result.failure, 'catalog_rejected'); await assert.rejects(readFile(f.audit));
});
test('partial reports and upstream failures remain distinct without exposing upstream error text', async t => {
  for (const mode of ['partial', 'error', 'invalid'] as const) {
    const f = await fixture(t, mode), result = await collectTrueNasHealth(f.target, { apiKey: 'test-only-api-key', directory: f.directory });
    assert.equal(result.status, mode === 'partial' ? 'partial' : 'failed');
    assert.equal(result.failure, mode === 'partial' ? undefined : mode === 'error' ? 'collection_failed' : 'invalid_report');
    if (mode === 'partial') assert.equal(result.evidence?.disks, null);
    assert.ok(!JSON.stringify(result).includes('test-only-api-key'));
  }
});
test('cancellation closes the child and records failure without retry or invented evidence', async t => {
  const f = await fixture(t, 'hang'), controller = new AbortController();
  const pending = collectTrueNasHealth(f.target, { apiKey: 'key', directory: f.directory, signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 3000); t.after(() => clearTimeout(timer));
  for (let i = 0; i < 100; i++) { try { await readFile(f.audit); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
  controller.abort();
  const result = await pending; assert.equal(result.failure, 'cancelled_or_timed_out'); assert.equal(result.evidence, undefined);
});
test('existing output and missing credentials fail before child launch', async t => {
  const f = await fixture(t); await writeFile(f.directory, 'occupied');
  await assert.rejects(collectTrueNasHealth(f.target, { apiKey: 'key', directory: f.directory }));
  await assert.rejects(collectTrueNasHealth(f.target, { apiKey: '', directory: f.directory + '-new' }));
  await assert.rejects(readFile(f.audit));
});
