import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { atomicJson } from '@onionsoup/runtime/storage';

export const TRUE_NAS_READ_TOOLS = [
  'truenas_alert_list', 'truenas_app_config', 'truenas_app_get', 'truenas_app_list', 'truenas_apps_update_report',
  'truenas_dataset_get', 'truenas_dataset_list', 'truenas_disk_list', 'truenas_health_report', 'truenas_jobs_list',
  'truenas_network_list', 'truenas_nfs_list', 'truenas_pool_get', 'truenas_pool_list', 'truenas_smb_list',
  'truenas_snapshot_get', 'truenas_snapshot_list', 'truenas_system_info',
] as const;
export const TrueNasTarget = z.object({ schemaVersion: z.literal(1), assetId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  binary: z.string().refine(isAbsolute, 'Binary must be absolute'),
  host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/), tlsInsecure: z.boolean().default(false) }).strict();
export type TrueNasTarget = z.infer<typeof TrueNasTarget>;
const Sections = ['system', 'system_state', 'pools', 'disks', 'alerts'] as const;
const Count = z.number().int().min(0).max(5000);
const Severity = z.enum(['EMERGENCY', 'ALERT', 'CRITICAL', 'ERROR', 'WARNING', 'WARN', 'NOTICE', 'INFO', 'DEBUG', 'unknown']);
export const TrueNasEvidence = z.object({ schemaVersion: z.literal(1), kind: z.literal('truenas-health-evidence'),
  coverage: z.object({ system: z.boolean(), system_state: z.boolean(), pools: z.boolean(), disks: z.boolean(), alerts: z.boolean() }).strict(),
  state: z.enum(['READY', 'BOOTING', 'SHUTTING_DOWN', 'other']).nullable(),
  pools: z.object({ count: Count, flagged: Count, unknown: Count }).strict().nullable(),
  disks: z.object({ count: Count }).strict().nullable(),
  alerts: z.object({ count: Count, dismissed: Count, bySeverity: z.record(Severity, Count) }).strict().nullable(),
  disposition: z.enum(['attention_required', 'no_flags_observed', 'unknown']),
}).strict();
export type TrueNasEvidence = z.infer<typeof TrueNasEvidence>;
// Unknown fields (including serials, topology, app configuration and alert prose) are never copied.
export function normalizeTrueNasHealth(raw: unknown): TrueNasEvidence {
  const report = z.object({ details: z.record(z.string(), z.unknown()), errors: z.record(z.string(), z.unknown()) }).parse(raw);
  const available = (key: typeof Sections[number]) => Object.hasOwn(report.details, key) && !Object.hasOwn(report.errors, key);
  const coverage = Object.fromEntries(Sections.map(key => [key, false])) as TrueNasEvidence['coverage'];
  coverage.system = available('system') && z.object({ version: z.string().min(1), uptime_seconds: z.number().nonnegative() }).safeParse(report.details.system).success;
  const state = available('system_state') && typeof report.details.system_state === 'string' ? report.details.system_state : null;
  coverage.system_state = state !== null;
  const poolRows = z.array(z.object({ status: z.string().optional(), healthy: z.boolean().optional(), warning: z.boolean().optional() })).max(5000).safeParse(report.details.pools);
  const diskRows = z.array(z.object({ name: z.string().min(1) })).max(5000).safeParse(report.details.disks);
  const alertRows = z.array(z.object({ level: z.string().optional(), dismissed: z.boolean() })).max(5000).safeParse(report.details.alerts);
  let pools: TrueNasEvidence['pools'] = null, disks: TrueNasEvidence['disks'] = null, alerts: TrueNasEvidence['alerts'] = null;
  if (available('pools') && poolRows.success) {
    coverage.pools = true;
    pools = { count: poolRows.data.length, flagged: 0, unknown: 0 };
    for (const row of poolRows.data) {
      if (row.healthy === false || row.warning === true || row.status !== undefined && row.status.toUpperCase() !== 'ONLINE') pools.flagged++;
      else if (row.healthy !== true || row.warning !== false || row.status?.toUpperCase() !== 'ONLINE') pools.unknown++;
    }
  }
  if (available('disks') && diskRows.success) { coverage.disks = true; disks = { count: diskRows.data.length }; }
  if (available('alerts') && alertRows.success) {
    coverage.alerts = true;
    alerts = { count: alertRows.data.length, dismissed: alertRows.data.filter(row => row.dismissed).length,
      bySeverity: Object.fromEntries(Severity.options.map(key => [key, 0])) as Record<z.infer<typeof Severity>, number> };
    for (const row of alertRows.data) {
      const level = Severity.safeParse(row.level?.toUpperCase()); alerts.bySeverity[level.success ? level.data : 'unknown']++;
    }
  }
  const flagged = (pools?.flagged ?? 0) > 0 || state !== null && state !== 'READY' ||
    alerts !== null && ['EMERGENCY', 'ALERT', 'CRITICAL', 'ERROR', 'WARNING', 'WARN'].some(level => alerts!.bySeverity[level as z.infer<typeof Severity>] > 0);
  const unknown = !Sections.every(key => coverage[key]) || (pools?.unknown ?? 0) > 0 || (alerts?.bySeverity.unknown ?? 0) > 0;
  return TrueNasEvidence.parse({ schemaVersion: 1, kind: 'truenas-health-evidence', coverage,
    state: state === null ? null : ['READY', 'BOOTING', 'SHUTTING_DOWN'].includes(state) ? state : 'other', pools, disks, alerts,
    disposition: flagged ? 'attention_required' : unknown ? 'unknown' : 'no_flags_observed' });
}
export function assertReadOnlyCatalog(tools: { name: string }[], nextCursor?: string) {
  if (nextCursor !== undefined || tools.length > 64 || new Set(tools.map(tool => tool.name)).size !== tools.length ||
    !tools.some(tool => tool.name === 'truenas_health_report') || tools.some(tool => !(TRUE_NAS_READ_TOOLS as readonly string[]).includes(tool.name)))
    throw new Error('Unexpected TrueNAS tool catalog');
}
export function trueNasLaunch(raw: unknown, apiKey: string) {
  const target = TrueNasTarget.parse(raw);
  if (!apiKey || apiKey.length > 8192 || /[\r\n\0]/.test(apiKey)) throw new Error('Missing or invalid credential');
  return { command: target.binary, args: ['serve', '--host', target.host, '--enable-writes=false', `--tls-insecure=${target.tlsInsecure}`],
    env: { TRUENAS_API_KEY: apiKey, TRUENAS_ENABLE_WRITES: 'false', TRUENAS_TLS_INSECURE: String(target.tlsInsecure) }, stderr: 'pipe' as const };
}
export const TrueNasRun = z.object({ schemaVersion: z.literal(1), kind: z.literal('truenas-observation'), runId: z.uuid(),
  assetId: TrueNasTarget.shape.assetId, targetHash: z.string().regex(/^[a-f0-9]{64}$/), binaryHash: z.string().regex(/^[a-f0-9]{64}$/), readOnly: z.literal(true), tlsInsecure: z.boolean(),
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().optional(), status: z.enum(['running', 'completed', 'partial', 'failed']),
  tools: z.array(z.enum(TRUE_NAS_READ_TOOLS)).max(64).optional(), evidence: TrueNasEvidence.optional(),
  failure: z.enum(['cancelled_or_timed_out', 'connection_failed', 'catalog_rejected', 'collection_failed', 'invalid_report']).optional(),
}).strict();
export type TrueNasRun = z.infer<typeof TrueNasRun>;

export async function collectTrueNasHealth(raw: unknown, options: { apiKey: string; directory: string; signal?: AbortSignal }) {
  const target = TrueNasTarget.parse(raw), launch = trueNasLaunch(target, options.apiKey);
  const binaryHash = createHash('sha256').update(await readFile(target.binary)).digest('hex');
  const record: TrueNasRun = { schemaVersion: 1, kind: 'truenas-observation', runId: randomUUID(), assetId: target.assetId,
    binaryHash, targetHash: createHash('sha256').update(JSON.stringify(target)).digest('hex'), readOnly: true, tlsInsecure: target.tlsInsecure, startedAt: new Date().toISOString(), status: 'running' };
  await mkdir(options.directory, { mode: 0o700 });
  let storageBroken = false;
  const save = async () => {
    try { await atomicJson(join(options.directory, 'observation.json'), TrueNasRun.parse(record)); }
    catch { storageBroken = true; throw new Error('Observation persistence failed'); }
  };
  await save(); // Never contact the NAS before durable admission.
  const client = new Client({ name: 'onionsoup-truenas-observer', version: '0.1.0' });
  const transport = new StdioClientTransport(launch);
  transport.stderr?.on('data', () => {}); // Drain without logging upstream errors, which can contain credentials/private data.
  const signal = AbortSignal.any([AbortSignal.timeout(45000), ...(options.signal ? [options.signal] : [])]);
  const abort = () => { void transport.close().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let stage: NonNullable<TrueNasRun['failure']> = 'connection_failed';
  try {
    signal.throwIfAborted();
    await client.connect(transport, { timeout: 15000, signal });
    if (client.getServerVersion()?.name !== 'truenas-mcp') throw new Error('Wrong server');
    stage = 'catalog_rejected';
    const catalog = await client.listTools({}, { timeout: 10000, signal });
    assertReadOnlyCatalog(catalog.tools, catalog.nextCursor);
    record.tools = catalog.tools.map(tool => tool.name) as TrueNasRun['tools'];
    // Persist discovered authority before the single permitted tool call.
    await save();
    stage = 'collection_failed';
    const response = await client.callTool({ name: 'truenas_health_report', arguments: {} }, undefined, { timeout: 25000, signal });
    if (response.isError) throw new Error('Tool failed');
    stage = 'invalid_report';
    if (!Array.isArray(response.content) || response.content.length !== 1 || response.content[0].type !== 'text' ||
      typeof response.content[0].text !== 'string' || Buffer.byteLength(response.content[0].text) > 2 * 1024 * 1024) throw new Error('Unexpected result');
    record.evidence = normalizeTrueNasHealth(JSON.parse(response.content[0].text));
    record.status = Object.values(record.evidence.coverage).every(Boolean) ? 'completed' : 'partial';
  } catch {
    if (storageBroken) throw new Error('Observation persistence failed');
    record.status = 'failed'; record.failure = signal.aborted ? 'cancelled_or_timed_out' : stage;
  }
  finally { signal.removeEventListener('abort', abort); await client.close().catch(() => {}); }
  record.finishedAt = new Date().toISOString(); await save(); return record;
}
