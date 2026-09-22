import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { composeHomelabBrief, renderHomelabBrief } from '../src/index.ts';
import { collectKubernetes } from '@onionsoup/kubernetes-source';
const execute=promisify(execFile);
const at='2026-09-19T12:00:00.000Z';
const container=()=>({schemaVersion:1,kind:'container-inventory',runId:randomUUID(),assetId:'containers-test',targetHash:'a'.repeat(64),commandVersion:'ssh-container-states-v1',
  readOnlyCommands:true,startedAt:at,finishedAt:at,status:'partial',queries:[
    {engine:'docker',scope:'local-default-docker-socket',commandHash:'b'.repeat(64),status:'unavailable',failure:'cli_unavailable'},
    {engine:'podman',scope:'ssh-user-local-podman',commandHash:'c'.repeat(64),status:'collected',counts:{total:0,states:[]}}]});
const nas=()=>({schemaVersion:1,kind:'truenas-observation',runId:randomUUID(),assetId:'nas-test',targetHash:'a'.repeat(64),binaryHash:'b'.repeat(64),readOnly:true,tlsInsecure:true,
  startedAt:at,finishedAt:at,status:'failed',failure:'collection_failed'});
test('brief preserves partial/unavailable vs zero, stale/future/running snapshots and source provenance',()=>{
  const record=composeHomelabBrief([container(),nas()],{now:new Date('2026-09-19T12:20:00Z')});
  assert.ok(record.sources.every(s=>s.freshness==='stale'));
  const md=renderHomelabBrief(record); assert.match(md,/coverage unavailable \(cli_unavailable\)/); assert.match(md,/0 containers\/instances; none/);
  assert.match(md,/TrueNAS coverage unavailable/); assert.match(md,/\*\*stale\*\*/); assert.match(md,/SHA-256/);
  for (const observation of [{...container(),status:'running',finishedAt:undefined},container()]) {
    assert.equal(composeHomelabBrief([observation],{now:new Date('2026-09-19T11:59:59Z')}).sources[0].freshness,'unknown');
  }
  const longRun={...container(),finishedAt:'2026-09-19T12:20:00Z'};
  assert.equal(composeHomelabBrief([longRun],{now:new Date('2026-09-19T12:20:01Z')}).sources[0].freshness,'stale');
  const fresh=composeHomelabBrief([container()],{now:new Date(at)}); assert.equal(fresh.sources[0].freshness,'fresh');
  const tampered=structuredClone(fresh); tampered.sources[0].freshness='stale'; assert.throws(()=>renderHomelabBrief(tampered));
  tampered.sources[0].freshness='fresh'; tampered.sources[0].digest='0'.repeat(64); assert.throws(()=>renderHomelabBrief(tampered));
});
test('duplicate assets, oversized batches and unexpected private fields fail closed',()=>{
  assert.throws(()=>composeHomelabBrief([container(),container()]));
  assert.throws(()=>composeHomelabBrief([])); assert.throws(()=>composeHomelabBrief(Array.from({length:33},container)));
  assert.throws(()=>composeHomelabBrief([{...nas(),credential:'secret'}]));
  assert.throws(()=>composeHomelabBrief([{...container(),assetId:'<script>alert(1)</script>'}]));
});
