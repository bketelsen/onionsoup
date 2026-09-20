import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicJson } from '@onionsoup/runtime/storage';
import { SshTarget, boundedSshArguments, runSshProcess, type QueryResult } from '@onionsoup/runtime/ssh';

export const KubernetesTarget = SshTarget.extend({ schemaVersion: z.literal(1),
  assetId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), access: z.enum(['direct', 'sudo']).default('direct'),
}).strict();
export type KubernetesTarget = z.infer<typeof KubernetesTarget>;
export const Section = z.enum(['nodes', 'pods', 'applications']);
export type Section = z.infer<typeof Section>;
const projections: Record<Section, string> = {
  nodes: '{"v1\\n"}{range .items[*]}{"n|"}{.status.conditions[?(@.type=="Ready")].status}{"\\n"}{end}',
  pods: '{"v1\\n"}{range .items[*]}{"p|"}{.status.phase}{"|"}{.status.conditions[?(@.type=="Ready")].status}{"\\n"}{end}',
  applications: '{"v1\\n"}{range .items[*]}{"a|"}{.status.health.status}{"|"}{.status.sync.status}{"\\n"}{end}',
};
export const SCOPES = { nodes: 'k3s-cluster-nodes', pods: 'k3s-all-namespaces', applications: 'k3s-all-namespaces-argocd-applications' } as const;
export function kubernetesCommand(raw: unknown, section: Section) {
  const target = KubernetesTarget.parse(raw); Section.parse(section);
  const prefix = target.access === 'sudo' ? '/usr/bin/sudo -n ' : '';
  const resource = section === 'applications' ? 'applications.argoproj.io' : section;
  // No interpolation of operator text into the remote command; all variants are finite.
  return `test -x /usr/bin/k3s || exit 69; exec ${prefix}/usr/bin/k3s kubectl --kubeconfig=/etc/rancher/k3s/k3s.yaml --context=default --server=https://127.0.0.1:6443 --request-timeout=10s --cache-dir=/dev/null get ${resource}${section === 'nodes' ? '' : ' --all-namespaces'} --chunk-size=200 -o 'jsonpath=${projections[section]}'`;
}
export function kubernetesSshArguments(raw: unknown, section: Section) {
  const target = KubernetesTarget.parse(raw);
  return boundedSshArguments(target, kubernetesCommand(target, section));
}
const Count = z.number().int().min(0).max(5000);
const readiness = z.object({ ready: Count, notReady: Count, unknown: Count }).strict();
const phases = z.object({ Pending: Count, Running: Count, Succeeded: Count, Failed: Count, Unknown: Count }).strict();
const health = z.object({ Healthy: Count, Progressing: Count, Degraded: Count, Suspended: Count, Missing: Count, Unknown: Count }).strict();
const sync = z.object({ Synced: Count, OutOfSync: Count, Unknown: Count }).strict();
const sum = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);
export const KubernetesEvidence = z.discriminatedUnion('section', [
  z.object({ section: z.literal('nodes'), total: Count, readiness }).strict(),
  z.object({ section: z.literal('pods'), total: Count, phases, readiness }).strict(),
  z.object({ section: z.literal('applications'), total: Count, health, sync }).strict(),
]).superRefine((value, ctx) => {
  const groups = value.section === 'nodes' ? [value.readiness] : value.section === 'pods' ? [value.phases, value.readiness] : [value.health, value.sync];
  if (groups.some(group => sum(group) !== value.total)) ctx.addIssue({ code: 'custom', message: 'Counts must partition total' });
});
export type KubernetesEvidence = z.infer<typeof KubernetesEvidence>;
export function normalizeKubernetes(section: Section, stdout: string): KubernetesEvidence {
  Section.parse(section);
  if (Buffer.byteLength(stdout) > 256 * 1024 || !stdout.startsWith('v1\n') || !stdout.endsWith('\n')) throw new Error('Invalid projection');
  const rows = stdout.slice(3, -1).split('\n');
  if (stdout === 'v1\n') rows.length = 0;
  if (rows.length > 5000) throw new Error('Row limit');
  const ready = { ready: 0, notReady: 0, unknown: 0 };
  const podPhases = { Pending: 0, Running: 0, Succeeded: 0, Failed: 0, Unknown: 0 };
  const appHealth = { Healthy: 0, Progressing: 0, Degraded: 0, Suspended: 0, Missing: 0, Unknown: 0 };
  const appSync = { Synced: 0, OutOfSync: 0, Unknown: 0 };
  const increment = <T extends Record<string, number>>(group: T, key: string) => {
    const safe = Object.hasOwn(group, key) ? key : 'Unknown'; group[safe as keyof T]++;
  };
  for (const row of rows) {
    const fields = row.split('|');
    if (fields.length !== (section === 'nodes' ? 2 : 3) || fields[0] !== { nodes: 'n', pods: 'p', applications: 'a' }[section] ||
        fields.slice(1).some(field => !/^[a-zA-Z]{0,40}$/.test(field))) throw new Error('Invalid row');
    if (section === 'applications') { increment(appHealth, fields[1]); increment(appSync, fields[2]); }
    else {
      const status = fields[section === 'nodes' ? 1 : 2];
      ready[status === 'True' ? 'ready' : status === 'False' ? 'notReady' : 'unknown']++;
      if (section === 'pods') increment(podPhases, fields[1]);
    }
  }
  return KubernetesEvidence.parse(section === 'nodes' ? { section, total: rows.length, readiness: ready } : section === 'pods'
    ? { section, total: rows.length, readiness: ready, phases: podPhases } : { section, total: rows.length, health: appHealth, sync: appSync });
}
const Failure = z.enum(['cli_unavailable','ssh_failed','query_failed','timeout','cancelled','output_limit','invalid_output']);
const Query = z.object({ section: Section, scope: z.enum(Object.values(SCOPES)), commandHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['pending','running','collected','unavailable','failed','not_attempted']), startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(), failure: Failure.optional(), evidence: KubernetesEvidence.optional(),
}).strict().superRefine((q, ctx) => {
  if ((q.status === 'collected') !== (q.evidence !== undefined) || q.evidence && q.evidence.section !== q.section ||
      q.scope !== SCOPES[q.section] || (['failed','unavailable','not_attempted'].includes(q.status)) !== (q.failure !== undefined))
    ctx.addIssue({ code: 'custom', message: 'Query status and evidence disagree' });
});
export const KubernetesRun = z.object({ schemaVersion: z.literal(1), kind: z.literal('kubernetes-observation'), runId: z.uuid(),
  assetId: KubernetesTarget.shape.assetId, targetHash: z.string().regex(/^[a-f0-9]{64}$/), commandVersion: z.literal('k3s-status-v1'),
  access: KubernetesTarget.shape.access, readOnlyCommands: z.literal(true), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().optional(),
  status: z.enum(['running','completed','partial','failed']), queries: z.array(Query).length(3),
}).strict().superRefine((run, ctx) => {
  const collected = run.queries.filter(q => q.status === 'collected').length;
  const expected = collected === 3 ? 'completed' : collected ? 'partial' : 'failed';
  if (new Set(run.queries.map(q => q.section)).size !== 3 || (run.status !== 'running' &&
      (!run.finishedAt || run.status !== expected || run.queries.some(q => ['pending','running'].includes(q.status)))))
    ctx.addIssue({ code: 'custom', message: 'Run status and queries disagree' });
});
export type KubernetesRun = z.infer<typeof KubernetesRun>;
export type KubernetesTransport = (target: KubernetesTarget, section: Section, signal: AbortSignal) => Promise<QueryResult>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export async function collectKubernetes(raw: unknown, options: { directory: string; signal?: AbortSignal; transport?: KubernetesTransport }) {
  const target = KubernetesTarget.parse(raw);
  const record: KubernetesRun = { schemaVersion: 1, kind: 'kubernetes-observation', runId: randomUUID(), assetId: target.assetId,
    targetHash: hash(JSON.stringify(target)), commandVersion: 'k3s-status-v1', access: target.access, readOnlyCommands: true,
    startedAt: new Date().toISOString(), status: 'running', queries: Section.options.map(section => ({ section, scope: SCOPES[section],
      commandHash: hash(kubernetesCommand(target, section)), status: 'pending' })) };
  await mkdir(options.directory, { mode: 0o700 });
  const save = () => atomicJson(join(options.directory, 'observation.json'), KubernetesRun.parse(record));
  await save();
  const deadline = AbortSignal.timeout(65000), signal = AbortSignal.any([deadline, ...(options.signal ? [options.signal] : [])]);
  for (const query of record.queries) {
    if (signal.aborted) { query.status = 'not_attempted'; query.failure = deadline.aborted ? 'timeout' : 'cancelled'; await save(); continue; }
    query.startedAt = new Date().toISOString(); query.status = 'running'; await save();
    let failure: 'query_failed'|'invalid_output' = 'query_failed';
    try {
      const result = await (options.transport ?? ((target, section, signal) => runSshProcess(kubernetesSshArguments(target, section), signal)))(target, query.section, signal);
      if (result.failure || signal.aborted) { query.status = 'failed'; query.failure = deadline.aborted ? 'timeout' : signal.aborted ? 'cancelled' : result.failure; }
      else if (result.code === 69) { query.status = 'unavailable'; query.failure = 'cli_unavailable'; }
      else if (result.code !== 0) { query.status = 'failed'; query.failure = result.code === 255 ? 'ssh_failed' : 'query_failed'; }
      else { failure = 'invalid_output'; query.evidence = normalizeKubernetes(query.section, result.stdout); query.status = 'collected'; }
    } catch { query.status = 'failed'; query.failure = failure; }
    query.finishedAt = new Date().toISOString(); await save();
  }
  const collected = record.queries.filter(q => q.status === 'collected').length;
  record.status = collected === 3 ? 'completed' : collected ? 'partial' : 'failed';
  record.finishedAt = new Date().toISOString(); await save(); return record;
}
