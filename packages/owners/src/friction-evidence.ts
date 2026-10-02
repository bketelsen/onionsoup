import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { WorkItem } from './ledger.ts';
import { ResourceRequest } from './requests.ts';
import { FrictionRecord, engineCommit, frictionDetail, safeProse, safeToolError } from './friction.ts';
import { ReviewEvidence, deskReviewRounds, reviewSubject } from './desk-reviews.ts';
import { readRequestWorkEvidence } from './request-work-evidence.ts';
import { rememberedSession } from './session-history.ts';
import { providerOf } from './provider-health.ts';
import { ProvidersFile, PROVIDERS_FILE, redactApiKeys } from './providers.ts';
import { familyOf } from './families.ts';
import { isCommitContainedInBase } from './git-containment.ts';
import { MaintenanceOperation } from './plugin-maintenance.ts';
import { AdmissionRecord } from './admission-record.ts';
import { maintenanceRuntimeBuildId, maintenanceQuarantineStatus, RuntimeReleaseManifest } from './maintenance-quarantine.ts';
import { expandHome } from './paths.ts';
import { parseJournalRecord } from './journal-record.ts';
import { spanMs } from './span.ts';
import type { Runtime } from './runtime.ts';

export const FRICTION_EVIDENCE_LIMITS = {
  records: 100, facts: 240, fieldChars: 240, recordBytes: 1_048_576, journalBytes: 1_048_576, journalFiles: 64,
  gitTimeoutMs: 5_000, gitBytes: 16_384, history: 12, bundleBytes: 65_536,
};
const scalar = z.union([z.string().max(FRICTION_EVIDENCE_LIMITS.fieldChars), z.number(), z.boolean(), z.null()]);
export const IncidentFact = z.object({
  key: z.string().max(FRICTION_EVIDENCE_LIMITS.fieldChars), source: z.enum(['configuration', 'host-record', 'local-git', 'installed-build']),
  status: z.enum(['observed', 'missing', 'error']), reason: z.string().optional(),
  values: z.record(z.string(), z.union([scalar, z.array(scalar).max(FRICTION_EVIDENCE_LIMITS.records)])),
}).strict();
export const IncidentBundle = z.object({
  version: z.literal(1), id: FrictionRecord.shape.id, collectedAt: z.string().datetime(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  facts: z.array(IncidentFact).max(FRICTION_EVIDENCE_LIMITS.facts),
  conditions: z.array(z.object({ key: z.string().max(FRICTION_EVIDENCE_LIMITS.fieldChars),
    reason: z.string().max(FRICTION_EVIDENCE_LIMITS.fieldChars), source: z.string().max(FRICTION_EVIDENCE_LIMITS.fieldChars) }))
    .max(FRICTION_EVIDENCE_LIMITS.records),
  abbreviated: z.boolean(),
}).strict();
export type IncidentBundle = z.infer<typeof IncidentBundle>;
type Fact = z.infer<typeof IncidentFact>;
const run = promisify(execFile);

function safeValue(runtime: Runtime, value: string) {
  value = redactApiKeys(value, runtime.declarations.providers);
  try { return safeProse(value).slice(0, FRICTION_EVIDENCE_LIMITS.fieldChars); }
  catch { return '[unsafe text omitted]'; }
}

function safeReason(reason: string | undefined) {
  if (!reason) return null;
  return /^[a-z][a-z_]+(?::|$)/.exec(reason)?.[0].replace(/:$/, '') ?? safeToolError(reason);
}

function remoteReference(remote: string) {
  try {
    const url = new URL(remote);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch { return remote.replace(/^[^/@\s]+@/, '[user]@'); }
}

function reasonOf(error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (error instanceof Error && ['not_regular_file', 'record_too_large'].includes(error.message)) return error.message;
  return typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code
    : error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid_record' : 'observation_unavailable';
}

class Collector {
  readonly facts: Fact[] = [];
  readonly conditions: IncidentBundle['conditions'] = [];
  abbreviated = false;
  constructor(readonly runtime: Runtime) {}

  add(key: string, source: Fact['source'], values: Fact['values'], status: Fact['status'] = 'observed', reason?: string) {
    if (this.facts.length >= FRICTION_EVIDENCE_LIMITS.facts) {
      this.abbreviated = true;
      return;
    }
    const cleaned = Object.fromEntries(Object.entries(values).map(([name, value]) => [
      name, Array.isArray(value) ? value.slice(0, FRICTION_EVIDENCE_LIMITS.records).map(entry =>
        typeof entry === 'string' ? safeValue(this.runtime, entry) : entry)
        : typeof value === 'string' ? safeValue(this.runtime, value) : value,
    ]));
    const fact = IncidentFact.parse({ key: safeValue(this.runtime, key), source, status, ...(reason ? { reason } : {}), values: cleaned });
    if (Buffer.byteLength(JSON.stringify({ facts: [...this.facts, fact], conditions: this.conditions })) >
      FRICTION_EVIDENCE_LIMITS.bundleBytes - FRICTION_EVIDENCE_LIMITS.fieldChars * 4) {
      this.abbreviated = true;
      return;
    }
    this.facts.push(fact);
    return true;
  }

  condition(key: string, source: string, reason: string, values: Fact['values']) {
    if (this.conditions.length >= FRICTION_EVIDENCE_LIMITS.records) {
      this.abbreviated = true;
      return;
    }
    const condition = IncidentBundle.shape.conditions.element.parse({ key, source, reason });
    if (Buffer.byteLength(JSON.stringify({ facts: this.facts, conditions: [...this.conditions, condition] })) >
      FRICTION_EVIDENCE_LIMITS.bundleBytes - FRICTION_EVIDENCE_LIMITS.fieldChars * 4) {
      this.abbreviated = true;
      return;
    }
    this.conditions.push(condition);
    if (!this.add(source, 'host-record', values)) this.conditions.pop();
  }

  async observe(key: string, source: Fact['source'], operation: () => Promise<Fact['values'] | undefined>) {
    try {
      const values = await operation();
      this.add(key, source, values ?? {}, values ? 'observed' : 'missing', values ? undefined : 'not_recorded');
    } catch (error) { this.add(key, source, {}, 'error', reasonOf(error)); }
  }
}

async function boundedText(path: string, limit = FRICTION_EVIDENCE_LIMITS.recordBytes) {
  const handle = await open(path, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('not_regular_file');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('record_too_large');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

async function records<Schema extends z.ZodType>(collector: Collector, directory: string, label: string, schema: Schema) {
  try {
    const names = (await readdir(directory)).filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name)).sort();
    if (names.length > FRICTION_EVIDENCE_LIMITS.records) collector.abbreviated = true;
    const entries: z.infer<Schema>[] = [];
    for (const name of names.slice(-FRICTION_EVIDENCE_LIMITS.records)) {
      try { entries.push(schema.parse(JSON.parse(await boundedText(join(directory, name))))); }
      catch (error) { collector.add(`${label}:${name}`, 'host-record', {}, 'error', reasonOf(error)); }
    }
    collector.add(`${label}:inventory`, 'host-record', { total: names.length, read: entries.length });
    return entries;
  } catch (error) {
    collector.add(`${label}:inventory`, 'host-record', {}, 'ENOENT' === (error as NodeJS.ErrnoException).code ? 'missing' : 'error', reasonOf(error));
    return [];
  }
}

function linkedItems(report: FrictionRecord, items: WorkItem[]) {
  const prose = [report.summary, report.actual, report.expected, report.evidence ?? ''].join('\n');
  const direct = items.filter(item => item.owner === report.owner && (
    item.origin?.sessionID === report.origin.sessionID || item.session?.sessionID === report.origin.sessionID
    || prose.includes(item.id) || (item.publication && prose.includes(item.publication.url))
    || (item.publication && new RegExp(`\\bPR\\s*#?${item.publication.url.split('/').at(-1)}\\b`, 'i').test(prose))));
  const ids = new Set(direct.map(item => item.id));
  return items.filter(item => ids.has(item.id) || (item.rebaseOf && ids.has(item.rebaseOf.itemId))
    || (item.repairOf && ids.has(item.repairOf.itemId)));
}

function checks(evidence: ReviewEvidence) {
  return { tree: evidence.tree, observedAt: evidence.observedAt, verifier: evidence.verifier,
    exitCodes: evidence.checks.map(check => check.exitCode), configurationIndexes: evidence.checks.map(check => check.configurationIndex) };
}

async function collectItem(collector: Collector, item: WorkItem, lastSeen: string) {
  collector.add(`item:${item.id}`, 'host-record', {
    owner: item.owner, status: item.status, reason: safeReason(item.reason), updatedAt: item.updatedAt,
    request: item.request ?? null, approvalAt: item.planApproval?.at ?? null,
    planDigest: item.planDocument?.digest ?? null, session: item.session?.sessionID ?? null,
    activeRunner: item.activeRunner ?? null, pr: item.publication?.url ?? null,
    publication: item.publication?.state ?? null, rebaseOf: item.rebaseOf?.itemId ?? null,
    previousHead: item.rebaseOf?.previousHead ?? null,
    repairOf: item.repairOf?.itemId ?? null, archives: item.planWorktreeArchives?.map(archive => archive.commit) ?? [],
    reviews: item.verdicts.map(verdict => verdict.decision),
    reviewBlockers: item.verdicts.map(verdict => verdict.findings.filter(finding => finding.severity === 'blocker').length),
    hires: item.hires.map(hire => `${hire.stage}:${hire.model}:${hire.family}:${hire.outcome}`),
  });
  const repository = item.proposal.repository;
  if (repository) await collector.observe(`reviews:${item.id}`, 'host-record', async () => {
    const rounds = await deskReviewRounds(collector.runtime, item.owner, reviewSubject(repository, item.planDocument ? item.id : undefined), true);
    const last = rounds.at(-1);
    return last ? { rounds: rounds.length, reviewer: last.reviewer, decision: last.decision,
      ...(last.evidence ? checks(last.evidence) : {}) } : undefined;
  });
  if (item.request) await collector.observe(`verification:${item.id}`, 'host-record', async () => {
    const evidence = await readRequestWorkEvidence(collector.runtime, item);
    return { stage: evidence.stage, observedAt: evidence.observedAt, blocker: evidence.blocker ?? null,
      ...(evidence.verification ? checks(evidence.verification) : {}),
      effects: evidence.operational?.effects.map(effect => `${effect.request}:${effect.postcondition}:${effect.observedAt}`) ?? [] };
  });
  if (item.requestAcceptance && item.requestAcceptance.acceptedAt >= lastSeen) collector.condition(
    `item:${item.id}:accepted`, `acceptance:${item.id}`, 'linked_original_goal_host_verified_and_accepted',
    { item: item.id, at: item.requestAcceptance.acceptedAt });
  const landedCommit = item.landedCommit;
  if (landedCommit && /^[a-f0-9]{40}$/.test(landedCommit)) {
    await collector.observe(`containment:${item.id}`, 'local-git', async () => {
      const owner = collector.runtime.repositoryFor(item);
      const base = `refs/remotes/origin/${owner.domain.baseBranch}`;
      return { source: landedCommit, base, contained: await isCommitContainedInBase(owner.workspace, base, landedCommit, boundedGit) };
    });
  }
}

function collectRequest(collector: Collector, request: ResourceRequest, lastSeen: string) {
  collector.add(`request:${request.id}`, 'host-record', {
    from: request.from, to: request.to, kind: request.ask.kind, status: request.status,
    workItem: request.workItem ?? null, updatedAt: request.updatedAt, reason: safeReason(request.reason),
    operation: request.operation?.id ?? null, stage: request.operation?.stage ?? null,
    runner: request.operation?.runner ?? null, remote: request.instance?.remote ?? null,
    instance: request.instance?.name ?? null, approvals: request.approvals.map(approval => `${approval.step}:${approval.at}`),
    followUp: request.followUp, followedUpAt: request.followUpResult?.at ?? null,
    followUpOk: request.followUpResult?.ok ?? null,
  });
  if (request.operation?.checkpoint) {
    const checkpoint = request.operation.checkpoint;
    collector.add(`effect:${request.id}`, 'host-record', {
      operation: request.operation.id, stage: request.operation.stage,
      instance: checkpoint.instance?.name ?? null, remote: checkpoint.instance?.remote ?? null,
      publication: checkpoint.publication?.commit ?? null,
      verifiedAt: checkpoint.publication?.verifiedAt ?? checkpoint.operational?.completedAt ?? null,
      postconditions: checkpoint.operational?.effects.map(effect => `${effect.request}:${effect.postcondition}`) ?? [],
    });
  }
  if (request.status === 'completed' && request.operation?.checkpoint?.operational
    && request.operation.checkpoint.operational.completedAt >= lastSeen) {
    collector.condition(`request:${request.id}:completed`, `completed:${request.id}`,
      'linked_host_verified_operation_completed', { request: request.id,
        at: request.operation.checkpoint.operational.completedAt });
  }
}

async function collectOwner(collector: Collector, id: string, itemIDs: ReadonlySet<string>, lastSeen: string) {
  if (!collector.runtime.declarations.owners.has(id)) {
    collector.add(`authority:${id}`, 'configuration', {}, 'missing', 'owner_no_longer_declared');
    return;
  }
  const owner = collector.runtime.owner(id);
  collector.add(`authority:${id}`, 'configuration', {
    model: owner.model, provider: providerOf(owner.model), family: familyOf(collector.runtime.declarations.families, owner.model),
    manager: owner.reportsTo ?? null, domain: owner.domain.kind,
    schedules: owner.duties.map(duty => `${duty.id}:${duty.kind}:${duty.every ?? 'unscheduled'}`),
    grants: owner.grants.map(grant => `${grant.action}:${grant.to}:${grant.target}`),
    credentialReferences: Object.entries(owner.mcp).map(([name, server]) => `${name}:${server.envFile ?? 'no-envfile-reference'}`),
    remotes: (owner.domain.kind === 'incus' ? owner.domain.remotes : owner.incus?.remotes ?? [])
      .map(remote => `${remote.name}:${remote.host}:${remote.allow.join(',')}`),
    truenasCredentialReference: owner.domain.kind === 'truenas' ? owner.domain.mcp.envFile : null,
    credentialAuthority: 'references-only-no-envfile-values',
  });
  if (owner.deploy) await collector.observe(`configured-deployment:${id}`, 'installed-build', async () => {
    const manifest = RuntimeReleaseManifest.parse(JSON.parse(await boundedText(
      join(expandHome(owner.deploy!.checkout), 'packages/surface/release-manifest.json'))));
    return { buildId: manifest.buildId, services: owner.deploy!.services, scope: 'configured-target-not-running-service-attestation' };
  });
  await collector.observe(`provider:${providerOf(owner.model)}`, 'host-record', async () => {
    const health = await collector.runtime.providerHealth.get(providerOf(owner.model));
    return health ? { status: health.status, since: health.since, lastFailureAt: health.lastFailureAt,
      recoveredAt: health.recoveredAt ?? null, failures: health.failures } : undefined;
  });
  await collectDutyChecks(collector, owner);
  await collectJournal(collector, id, itemIDs, lastSeen);
}

async function collectDutyChecks(collector: Collector, owner: ReturnType<Runtime['owner']>) {
  const id = owner.id;
  await collector.observe(`duty-checks:${id}`, 'host-record', async () => {
    const state = z.record(z.string(), z.string()).parse(JSON.parse(await boundedText(join(collector.runtime.stateDirectory, 'duties.json'))));
    return { lastRuns: owner.duties.map(duty => `${duty.id}:${state[`${id}/${duty.id}`] ?? 'not_recorded'}`),
      due: owner.duties.filter(duty => duty.every && Date.now() - Date.parse(state[`${id}/${duty.id}`] ?? '1970-01-01') >= spanMs(duty.every!))
        .map(duty => duty.id) };
  });
}

async function collectJournal(collector: Collector, id: string, itemIDs: ReadonlySet<string>, lastSeen: string) {
  await collector.observe(`journal:${id}`, 'host-record', async () => {
    const directory = join(collector.runtime.notebook(id).directory, 'journal');
    const files = (await readdir(directory)).filter(name =>
      /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) >= lastSeen.slice(0, 10)).sort();
    if (!files.length) return undefined;
    let remaining = FRICTION_EVIDENCE_LIMITS.journalBytes;
    const events: string[] = [];
    if (files.length > FRICTION_EVIDENCE_LIMITS.journalFiles) collector.abbreviated = true;
    for (const file of files.slice(0, FRICTION_EVIDENCE_LIMITS.journalFiles)) {
      if (!remaining) {
        collector.abbreviated = true;
        break;
      }
      const scanned = await journalPrefix(join(directory, file), remaining);
      remaining -= scanned.bytes;
      if (scanned.abbreviated) collector.abbreviated = true;
      for (const line of scanned.lines) {
        const entry = parseJournalRecord(line);
        if (!entry || entry.at < lastSeen) continue;
        events.push(`${entry.at}:${entry.kind}:${entry.workItem ?? ''}:${entry.stage ?? ''}`);
        if (entry.kind !== 'attention-condition' || entry.condition?.state !== 'resolved'
          || !entry.workItem || !itemIDs.has(entry.workItem)) continue;
        const identity = createHash('sha256').update(JSON.stringify([id, entry.condition.key, entry.at])).digest('hex');
        collector.condition(entry.condition.key, `condition:${identity}`,
          'linked_host_condition_resolved', { key: entry.condition!.key, state: 'resolved',
            at: entry.at, item: entry.workItem ?? null });
      }
    }
    return { events: events.slice(-FRICTION_EVIDENCE_LIMITS.history),
      scan: collector.abbreviated ? 'bounded_scan_abbreviated' : 'bounded_scan_complete' };
  });
}

async function journalPrefix(path: string, budget: number) {
  const handle = await open(path, 'r');
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new Error('not_regular_file');
    const buffer = Buffer.alloc(Math.min(details.size, budget));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const complete = buffer.subarray(0, bytesRead).lastIndexOf(10) + 1;
    return { bytes: bytesRead, abbreviated: bytesRead < details.size,
      lines: buffer.subarray(0, complete).toString('utf8').split('\n').slice(0, -1) };
  } finally { await handle.close(); }
}

async function gitFacts(collector: Collector, directory: string, label: string, args: string[]) {
  await collector.observe(label, 'local-git', async () => {
    const { stdout } = await run('git', ['-C', directory, ...args], {
      timeout: FRICTION_EVIDENCE_LIMITS.gitTimeoutMs, maxBuffer: FRICTION_EVIDENCE_LIMITS.gitBytes,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    return { facts: stdout.trim().split('\n').slice(0, FRICTION_EVIDENCE_LIMITS.history) };
  });
}

async function boundedGit(directory: string, args: string[]) {
  const { stdout } = await run('git', ['-C', directory, ...args], {
    timeout: FRICTION_EVIDENCE_LIMITS.gitTimeoutMs, maxBuffer: FRICTION_EVIDENCE_LIMITS.gitBytes,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
}

/** Only configured roots, typed record identities and fixed read-only argv enter this collector. */
export async function collectIncidentBundle(runtime: Runtime, report: FrictionRecord, policy: { owner: string; repository: string }) {
  const collector = new Collector(runtime);
  collector.add(`capture:${report.id}`, 'host-record', { count: report.count, lastSeen: report.lastSeen });
  const items = await records(collector, runtime.ledger.directory, 'ledger', WorkItem);
  const requests = await records(collector, runtime.requests.directory, 'requests', ResourceRequest);
  const linked = linkedItems(report, items);
  const ids = new Set(linked.map(item => item.id));
  const prose = [report.summary, report.expected, report.actual, report.evidence ?? ''].join('\n');
  const related = requests.filter(request => (request.workItem && ids.has(request.workItem))
    || ((request.from === report.owner || request.to === report.owner) && (
      prose.includes(request.id) || request.origin?.sessionID === report.origin.sessionID)));
  for (const item of linked) await collectItem(collector, item, report.lastSeen);
  for (const request of related) collectRequest(collector, request, report.lastSeen);
  if (!linked.length) collector.add('linked-ledger', 'host-record', {}, 'missing', 'no_linked_item');
  if (!related.length) collector.add('linked-requests', 'host-record', {}, 'missing', 'no_linked_request');
  for (const id of new Set([report.owner, policy.owner, ...related.flatMap(request => [request.from, request.to])])) {
    await collectOwner(collector, id, ids, report.lastSeen);
  }
  const sessionIDs = new Set([report.origin.sessionID, ...linked.flatMap(item => [item.session?.sessionID, item.origin?.sessionID]).filter(id => id !== undefined)]);
  for (const id of sessionIDs) await collector.observe(`session:${id}`, 'host-record', async () => {
    const session = await rememberedSession(runtime, id);
    return session ? { owner: session.owner, item: session.item ?? null, parent: session.parentID ?? null,
      archived: session.archived ?? false, updatedAt: session.time.updated } : undefined;
  });
  await collectRepository(collector, report, policy);
  await collectMaintenance(collector);
  return finishBundle(collector, report.id);
}

async function collectRepository(collector: Collector, report: FrictionRecord, policy: { owner: string; repository: string }) {
  const runtime = collector.runtime;
  const owner = runtime.repositoryOwner(policy.owner, policy.repository);
  collector.add('repository-authority', 'configuration', { repository: owner.domain.name,
    remote: remoteReference(owner.domain.remote), base: owner.domain.baseBranch,
    verifyExecutables: owner.domain.verify.map(command => command[0] ?? '') });
  await collector.observe('provider-credential-references', 'configuration', async () => {
    const declarations = ProvidersFile.parse(parseYaml(await boundedText(join(runtime.declarations.root, PROVIDERS_FILE))));
    return { references: Object.entries(declarations).map(([id, provider]) => `${id}:${provider.apiKeyFile ?? 'no-secret-reference'}`) };
  });
  await collector.observe('installed-build', 'installed-build', async () => {
    const build = await maintenanceRuntimeBuildId();
    return build ? { buildId: build, scope: 'collector-process-not-service-attestation' } : undefined;
  });
  collector.add('engine-source', 'local-git', { commit: await engineCommit(), reportedCommit: report.commit });
  await gitFacts(collector, owner.workspace, 'source-head', ['rev-parse', 'HEAD']);
  await gitFacts(collector, owner.workspace, 'source-history', ['log', `-${FRICTION_EVIDENCE_LIMITS.history}`, '--format=%H %P']);
  await gitFacts(collector, owner.workspace, 'source-base', ['rev-parse', `refs/remotes/origin/${owner.domain.baseBranch}`]);
  collector.add('freshness', 'local-git', { scope: 'local-only-not-fetched', liveServiceBuild: 'not_attested',
    liveProviderProbe: 'not_performed' });
}

async function collectMaintenance(collector: Collector) {
  const runtime = collector.runtime;
  await collector.observe('maintenance-quarantine', 'host-record', async () => ({ ...await maintenanceQuarantineStatus(runtime.stateDirectory) }));
  const operations = await maintenanceRecords(collector);
  for (const operation of operations.filter(operation => !['settled', 'released'].includes(operation.status))) collector.add(`maintenance:${operation.operationID}`, 'host-record', {
    instance: operation.instanceID, kind: operation.kind, status: operation.status, phase: operation.phase,
    startedAt: operation.startedAt, endedAt: operation.endedAt ?? null,
    effects: operation.calls.map(call => `${call.method}:${call.effect}:${call.status}`),
  });
  const admissions = await records(collector, join(runtime.stateDirectory, 'deploy', 'leases'), 'admissions', AdmissionRecord);
  for (const admission of admissions.filter(admission => !['daemon-friction', 'daemon-tick'].includes(admission.kind))) collector.add(`admission:${admission.id}`, 'host-record', {
    kind: admission.kind, pid: admission.pid, startTime: admission.startTime,
    operation: admission.maintenance?.operationID ?? null,
  });
}

function finishBundle(collector: Collector, id: string) {
  const content = {
    facts: collector.facts.sort((left, right) => left.key.localeCompare(right.key)),
    conditions: collector.conditions.sort((left, right) =>
      left.key.localeCompare(right.key) || left.source.localeCompare(right.source)),
    abbreviated: collector.abbreviated,
  };
  return IncidentBundle.parse({ version: 1, id, collectedAt: new Date().toISOString(), ...content,
    digest: createHash('sha256').update(JSON.stringify({
      conditions: content.conditions, facts: content.facts.flatMap(refreshFact),
    })).digest('hex') });
}

const REFRESH_OMISSIONS: Record<string, ReadonlySet<string> | null> = {
  'duty-checks': null, journal: null, admission: null, maintenance: null, 'maintenance-uncertain': null,
  provider: new Set(['since', 'lastFailureAt', 'recoveredAt', 'failures']),
  session: new Set(['updatedAt']),
  item: new Set(['updatedAt']),
  request: new Set(['updatedAt']),
};

function refreshFact(fact: Fact): Fact[] {
  if (fact.key.endsWith(':inventory')) return [];
  const prefix = fact.key.split(':')[0]!;
  const omissions = REFRESH_OMISSIONS[prefix];
  if (omissions === null) return [];
  if (!omissions) return [fact];
  return [{ ...fact, values: Object.fromEntries(Object.entries(fact.values).filter(([key]) => !omissions.has(key))) }];
}

export function incidentCaptureIsCurrent(bundle: IncidentBundle | undefined, report: FrictionRecord, closedAt: string) {
  const capture = bundle?.facts.find(fact => fact.key === `capture:${report.id}`);
  return capture ? capture.values.count === report.count && capture.values.lastSeen === report.lastSeen
    : report.lastSeen <= (bundle?.collectedAt ?? closedAt);
}

async function maintenanceRecords(collector: Collector) {
  const directory = join(collector.runtime.stateDirectory, 'plugin-maintenance');
  try {
    const instances = (await readdir(directory)).filter(name => z.uuid().safeParse(name).success).sort()
      .slice(0, FRICTION_EVIDENCE_LIMITS.records);
    const operations: z.infer<typeof MaintenanceOperation>[] = [];
    for (const instance of instances) {
      operations.push(...await records(collector, join(directory, instance), `maintenance:${instance}`, MaintenanceOperation));
      operations.push(...await records(collector, join(directory, instance, 'uncertain'), `maintenance-uncertain:${instance}`, MaintenanceOperation));
    }
    return operations.slice(-FRICTION_EVIDENCE_LIMITS.records);
  } catch (error) {
    collector.add('maintenance:inventory', 'host-record', {}, (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'error', reasonOf(error));
    return [];
  }
}

/** A fixing revision must name an actual host-observed postcondition, not source citations alone. */
export function incidentResolutionReason(bundle: IncidentBundle, conditionKeys: string[] | undefined) {
  if (!conditionKeys?.length || !conditionKeys.every(key => bundle.conditions.some(condition => condition.key === key))) {
    return 'friction_operational_condition_unverified';
  }
  return undefined;
}

export async function currentIncidentResolutionReason(runtime: Runtime, bundle: IncidentBundle,
  policy: { owner: string; repository: string }, conditionKeys: string[] | undefined) {
  const capturedReason = incidentResolutionReason(bundle, conditionKeys);
  if (capturedReason) return capturedReason;
  const current = await collectIncidentBundle(runtime, await frictionDetail(runtime, bundle.id), policy);
  return incidentResolutionReason(current, conditionKeys);
}
