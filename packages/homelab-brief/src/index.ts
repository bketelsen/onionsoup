import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { TriageRun } from '@onionsoup/workload-triage';
import { text } from '@onionsoup/runtime/text';
import { z } from 'zod';
import { TrueNasRun } from '@onionsoup/truenas-source';
import { ContainerRun } from '@onionsoup/container-source';
import { KubernetesRun } from '@onionsoup/kubernetes-source';

export const HomelabObservation = z.union([TrueNasRun, ContainerRun, KubernetesRun, TriageRun]);
export type HomelabObservation = z.infer<typeof HomelabObservation>;
const Source = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/),
  freshness: z.enum(['fresh','stale','unknown']), observation: HomelabObservation }).strict();
export const HomelabBrief = z.object({ schemaVersion: z.literal(1), kind: z.literal('homelab-brief'), runId: z.uuid(),
  generatedAt: z.iso.datetime(), maxAgeSeconds: z.number().int().min(1).max(86400), sources: z.array(Source).min(1).max(32),
}).strict();
export type HomelabBrief = z.infer<typeof HomelabBrief>;
const hash = (raw: unknown) => createHash('sha256').update(JSON.stringify(raw)).digest('hex');
function freshness(observation: HomelabObservation, generatedAt: string, maxAgeSeconds: number): 'fresh'|'stale'|'unknown' {
  const start = Date.parse(observation.kind === 'workload-triage' ? observation.input.startedAt : observation.startedAt), end = observation.finishedAt ? Date.parse(observation.finishedAt) : NaN;
  const now = Date.parse(generatedAt);
  if (observation.status === 'running' || !Number.isFinite(end) || end < start || end > now) return 'unknown';
  // Age begins at the oldest read, not when the last query completed.
  return now - start > maxAgeSeconds * 1000 ? 'stale' : 'fresh';
}
export function composeHomelabBrief(raw: unknown[], options: { now?: Date; maxAgeSeconds?: number } = {}): HomelabBrief {
  const observations = z.array(HomelabObservation).min(1).max(32).parse(raw);
  const generatedAt = (options.now ?? new Date()).toISOString(), maxAgeSeconds = options.maxAgeSeconds ?? 900;
  const keys = observations.map(o => `${o.kind}:${o.assetId}`);
  if (new Set(keys).size !== keys.length || new Set(observations.map(o => o.runId)).size !== observations.length) throw new Error('Duplicate observation');
  return HomelabBrief.parse({ schemaVersion: 1, kind: 'homelab-brief', runId: randomUUID(), generatedAt, maxAgeSeconds,
    sources: observations.map(observation => ({ digest: hash(observation), freshness: freshness(observation, generatedAt, maxAgeSeconds), observation })) });
}
const counts = (group: Record<string, number>) => Object.entries(group).filter(([,count]) => count > 0).map(([state,count]) => `${count} ${state}`).join(', ') || 'none';
export function renderHomelabBrief(raw: unknown): string {
  const brief = HomelabBrief.parse(raw);
  // Revalidate derived claims on replay; disk artifacts are not authority.
  const derived = composeHomelabBrief(brief.sources.map(s => s.observation), { now: new Date(brief.generatedAt), maxAgeSeconds: brief.maxAgeSeconds });
  if (brief.sources.some((s,i) => s.digest !== derived.sources[i].digest || s.freshness !== derived.sources[i].freshness)) throw new Error('Invalid provenance');
  const lines = ['# Homelab brief', '', `Generated ${brief.generatedAt}. Freshness threshold: ${brief.maxAgeSeconds}s at generation.`, '',
    'Saved observations only; no live refresh or overall health score. Running containers are not proof of service health. Pod readiness and Argo health/sync are separate signals.', ''];
  for (const source of brief.sources) {
    const o = source.observation;
    lines.push(`## ${o.assetId}`, '', `Collection: **${o.status}**. Freshness at generation: **${source.freshness}**.`,
      `Observed ${o.startedAt} to ${o.finishedAt ?? 'unfinished'}. Run: ${o.runId}.`, `Source SHA-256: ${source.digest}.`, '');
    if (o.kind === 'truenas-observation') {
      const e = o.evidence;
      if (!e || o.status === 'failed' || o.status === 'running') lines.push(`TrueNAS coverage unavailable (${o.failure ?? o.status}).`);
      else {
        lines.push(`NAS state: ${e.coverage.system_state ? e.state ?? 'unknown' : 'unavailable'}. Report disposition: ${e.disposition}.`,
          `Sections collected: ${Object.entries(e.coverage).filter(([,ok])=>ok).map(([key])=>key).join(', ') || 'none'}.`,
          `Missing sections: ${Object.entries(e.coverage).filter(([,ok])=>!ok).map(([key])=>key).join(', ') || 'none'}.`,
          e.coverage.pools && e.pools ? `Pools: ${e.pools.count}; ${e.pools.flagged} flagged, ${e.pools.unknown} unknown.` : 'Pools: unavailable.',
          e.coverage.disks && e.disks ? `Disks: ${e.disks.count}.` : 'Disks: unavailable.',
          e.coverage.alerts && e.alerts ? `Alerts: ${e.alerts.count}; ${e.alerts.dismissed} dismissed; ${counts(e.alerts.bySeverity)}.` : 'Alerts: unavailable.');
      }
    } else if (o.kind === 'container-inventory') {
      for (const q of o.queries) lines.push(`- ${q.engine} (${q.scope}): ${q.status === 'collected' && q.counts
        ? `${q.counts.total} containers/instances; ${q.counts.states.map(s => `${s.count} ${s.state}`).join(', ') || 'none'}`
        : `coverage ${q.status} (${q.failure ?? 'no completed query'})`}.`);
      lines.push('', 'Podman covers the SSH user only; Docker covers its configured socket. Incus may span a cluster. Do not sum these inventories as distinct machines.');
    } else if (o.kind === 'workload-triage') {
      lines.push('### Attention', '', `Source run: ${o.input.runId}; observed ${o.input.startedAt} to ${o.input.finishedAt ?? 'unfinished'}.`,
        `Source coverage: ${o.input.queries.map(q => `${q.section}=${q.status}`).join(', ')}.`,
        `Selected ${o.input.selected.length} of ${o.input.eligible ?? 'unknown'} eligible pods; omitted ${o.input.omitted ?? 'unknown'}.`,
        'Model assessment of this snapshot; findings suggest investigation, not service actions.', '');
      if (o.status !== 'completed' || !o.result) lines.push(`Assessment unavailable (${o.failure ?? o.status}).`);
      else if (!o.result.findings.length) lines.push('No candidate pods selected in this source snapshot. This is not an overall health assessment.');
      else for (const f of o.result.findings) lines.push(`- **${f.classification}** — ${f.podId}: ${text(f.reason)} Next: ${f.nextInvestigation}. Evidence: ${f.evidenceIds.join(', ')}.`);
    } else {
      lines.push('Cluster scope: host-local k3s endpoint; all visible namespaces. Resources may run on other cluster nodes.', '');
      for (const q of o.queries) {
        const e = q.evidence;
        if (q.status !== 'collected' || !e) lines.push(`- ${q.section}: coverage ${q.status} (${q.failure ?? 'no completed query'}).`);
        else if (e.section === 'nodes') lines.push(`- Nodes: ${e.total}; readiness: ${counts(e.readiness)}.`);
        else if (e.section === 'pods') lines.push(`- Pods: ${e.total}; phases: ${counts(e.phases)}; readiness: ${counts(e.readiness)}.`);
        else lines.push(`- Argo CD applications: ${e.total}; health: ${counts(e.health)}; sync: ${counts(e.sync)}.`);
      }
      lines.push('', 'Succeeded pods need not remain Ready. OutOfSync indicates desired/live drift; it does not authorize sync. Argo statuses are controller-reported and may lag. No per-resource diagnosis is included.');
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

// Operator-configured files only; MCP clients never supply paths.
export async function readHomelabObservation(file:string,signal?:AbortSignal):Promise<HomelabObservation>{
  const handle=await open(file,'r');
  try{
    if(!(await handle.stat()).isFile())throw new Error('Expected observation file');
    const buffer=Buffer.alloc(1024*1024+1);let offset=0;
    while(offset<buffer.length){signal?.throwIfAborted();const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
    if(offset>1024*1024)throw new Error('Observation too large');
    return HomelabObservation.parse(JSON.parse(buffer.subarray(0,offset).toString('utf8')));
  }finally{await handle.close();}
}
