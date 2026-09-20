import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { capabilityCatalog, capabilityManifest, AgentId } from '../src/capabilities.ts';
import { workflowEvents, WorkflowEventExport } from '../src/workflow-events.ts';
import { triage } from '../src/triage.ts';
import { fixtureModel } from '../src/fixture-model.ts';
import type { Packet } from '../src/packet.ts';

const issue = { schemaVersion: 1 as const, repository: 'example/widget', number: 1,
  updatedAt: '2026-09-18T12:00:00Z', title: 'Private issue text', body: 'Private report content' };
const feature = { schemaVersion: 2, kind: 'feature_request', bug_readiness: 'not_applicable',
  summary: 'Private assessment narrative', evidence: [], questions: [] };
const ready = { schemaVersion: 2, kind: 'bug_report', bug_readiness: 'ready', summary: 'Private readiness narrative',
  evidence: ['reproduction', 'expected', 'actual', 'environment'].map(field => ({ field, source: 'body', quote: issue.body })), questions: [] };
const record = (assessment: unknown = feature) => triage(issue, { model: fixtureModel([assessment]), provider: 'copilot', modelId: 'gpt-5.6-terra' });
function packet(r: Awaited<ReturnType<typeof record>>, reusedReadiness = true): Packet {
  return { schemaVersion: 1, packetId: '11111111-1111-4111-8111-111111111111', createdAt: '2026-09-18T23:00:00Z',
    finishedAt: '2026-09-18T23:01:00Z', status: 'completed', stage: 'done', issue, inputHash: r.inputHash,
    repository: { name: issue.repository, commit: 'a'.repeat(40) }, execution: { provider: 'copilot', model: 'gpt-5.6-terra' },
    reusedReadiness, readiness: r, locationDisposition: 'not_eligible' };
}

test('published manifests are usable without credentials and identify callable implementations and schema versions', async () => {
  for (const item of capabilityCatalog().agents) {
    const manifest = capabilityManifest(AgentId.parse(item.id));
    assert.deepEqual(JSON.parse(await readFile(item.manifest, 'utf8')), manifest);
    const module = await import(manifest.invocation.module.startsWith('@onionsoup/') ? manifest.invocation.module : `../${manifest.invocation.module}`);
    assert.equal(typeof module[manifest.invocation.export], 'function');
    assert.equal(manifest.effects.githubWrites, false); assert.equal(manifest.effects.targetCodeExecution, false);
    assert.equal(manifest.lifecycle.durableResume, false);
    if(item.id==='change-proposal') {
      const variants=manifest.contracts.inputSchema.oneOf as Array<{type:string;properties:{changeKind:{const:string}}}>;
      assert.deepEqual(variants.map(v=>v.properties.changeKind.const),['bug_fix','feature']);
      assert.ok(variants.every(v=>v.type==='object'));
    } else if(item.id==='workload-triage'){
      const variants=manifest.contracts.inputSchema.anyOf as Array<{type:string;properties:{schemaVersion:{const:number}}}>;
      assert.deepEqual(variants.map(v=>v.properties.schemaVersion.const),[1,2]);assert.ok(variants.every(v=>v.type==='object'));
    } else assert.equal(manifest.contracts.inputSchema.type, 'object');
    assert.equal(manifest.contracts.resultSchema.type, 'object');
  }
  const manifest = capabilityManifest('bug-readiness');
  const module = await import(manifest.invocation.module.startsWith('@onionsoup/') ? manifest.invocation.module : `../${manifest.invocation.module}`);
  const result = await module[manifest.invocation.export](issue, { model: fixtureModel([feature]), provider: 'fixture', modelId: 'scripted' });
  assert.equal(result.schemaVersion, manifest.contracts.runVersion);
  assert.equal(result.assessment.schemaVersion, manifest.contracts.resultVersion);
  assert.equal(result.status, 'completed');
});

test('common events are stable, preserve non-bug outcomes, and contain no raw task or model prose', async () => {
  const r = await record(); const original = JSON.stringify(r);
  const exported = workflowEvents(r);
  assert.deepEqual(exported, workflowEvents(r));
  assert.equal(JSON.stringify(r), original);
  const end = exported.events.find(e => e.type === 'agent.completed')!;
  assert.equal(end.requestKind, 'feature_request'); assert.equal(end.outcome, 'not_applicable');
  assert.equal(exported.events.at(-1)?.type, 'workflow.completed');
  assert.ok(exported.events.some(e => e.type === 'agent.step_started'));
  for (const secret of [issue.title, issue.body, feature.summary, 'messages', 'evidence']) assert.ok(!JSON.stringify(exported).includes(secret));
  const corrupt = structuredClone(exported); corrupt.events[0].sequence = 99;
  assert.throws(() => WorkflowEventExport.parse(corrupt), /sequence/);
  assert.throws(() => workflowEvents({ ...r, inputHash: '0'.repeat(64) }), /identity/);
  assert.throws(() => workflowEvents({ ...r, model: undefined }), /Invalid readiness/);
});

test('reuse is a reference with historical usage, never duplicate starts or new charged usage', async () => {
  const p = packet(await record()); const exported = workflowEvents(p);
  const reused = exported.events.find(e => e.type === 'agent.reused')!;
  assert.equal(reused.at, p.createdAt); assert.equal(reused.originalStartedAt, p.readiness?.startedAt);
  assert.equal(reused.usage, undefined); assert.ok(reused.historicalUsage);
  assert.ok(!exported.events.some(e => e.type === 'agent.started' || e.type === 'agent.step_started'));
  assert.ok(exported.events.some(e => e.type === 'stage.skipped' && e.reason === 'not_eligible'));
  const corrupt = structuredClone(exported); corrupt.events[1].usage = reused.historicalUsage;
  assert.throws(() => WorkflowEventExport.parse(corrupt), /historical/);
});

test('unfinished and failed artifacts stay explicit and arbitrary failure strings never enter events', async () => {
  const r = await record();
  const running = { ...r, status: 'running', finishedAt: undefined, assessment: undefined, tokenUsage: undefined };
  const unfinished = workflowEvents(running);
  assert.equal(unfinished.events.at(-1)?.type, 'workflow.unfinished');
  assert.equal(unfinished.events.find(e => e.type === 'agent.unfinished')?.outcome, undefined);
  const failed = workflowEvents({ ...r, status: 'failed', assessment: undefined, failure: 'Bearer do-not-export-me' });
  assert.equal(failed.events.find(e => e.type === 'agent.failed')?.failure, 'unknown_failure');
  assert.ok(!JSON.stringify(failed).includes('do-not-export-me'));
  const p = { ...packet(await record(ready)), status: 'partial', locationDisposition: 'failed', failure: 'stage_execution_or_persistence_error' };
  const partial = workflowEvents(p);
  assert.equal(partial.events.at(-1)?.type, 'workflow.partial');
  assert.ok(partial.events.some(e => e.type === 'stage.failed' && e.agent === 'code-location' && !e.runId));
  assert.ok(!partial.events.some(e => e.type === 'agent.started' && e.agent === 'code-location'));
});

test('legacy readiness retains out_of_scope and unknown measurements remain null or absent', async () => {
  const r = await record();
  const legacy = { ...r, schemaVersion: 1, assessment: { disposition: 'out_of_scope', summary: 'Historical decision', evidence: [], questions: [] },
    tokenUsage: { totals: { inputTokens: 7, outputTokens: undefined, estimatedCostUsd: NaN } } };
  const event = workflowEvents(legacy).events.find(e => e.type === 'agent.completed')!;
  assert.equal(event.recordVersion, 1); assert.equal(event.requestKind, 'unclassified_legacy'); assert.equal(event.outcome, 'out_of_scope');
  assert.equal(event.usage?.inputTokens, 7); assert.equal(event.usage?.outputTokens, null); assert.equal(event.usage?.estimatedCostUsd, null);
});
