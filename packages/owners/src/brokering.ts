import { randomUUID } from 'node:crypto';
import { decideWork, journalRequest, trackDelegatedWork } from './delegation.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishDecisionBrief, requestDecisionBrief } from './briefs.ts';
import { updateApp } from './app-updates.ts';
import { publishSite } from './publish-site.ts';
import { rosterText } from './roster.ts';
import { checkCreate, createInstance, deleteInstance, INCUS_LIMITS } from './incus.ts';
import { refreshWorkspace } from './owner.ts';
import { describeAsk, REQUEST_LIMITS, requestRunnerIsAlive, OwnerDecision, PublishDecision, requireStatus, type ResourceAsk, type ResourceRequest } from './requests.ts';
import type { Runtime } from './runtime.ts';
import { runSandboxed } from './sandbox.ts';

/** An owner asks another owner for an instance. The request waits for the receiving owner's decision. */
export async function requestInstance(runtime: Runtime, from: string, to: string, ask: ResourceAsk, followUp: string) {
  if (ask.kind === 'instance') runtime.incusOwner(to);
  const request = await runtime.requests.open(from, to, ask, followUp);
  await journalRequest(runtime, request, 'request-opened', `${describeAsk(ask)} for ${ask.purpose}`);
  return request;
}

/** An owner asks the owner that hosts one of its sites to publish it. */
export async function requestPublish(runtime: Runtime, from: string, siteId: string, purpose: string) {
  const host = [...runtime.declarations.owners.values()].find(owner => owner.domain.kind === 'truenas' && owner.domain.sites.some(site => site.id === siteId));
  if (!host) throw new Error(`no owner hosts site ${siteId}`);
  return requestInstance(runtime, from, host.id, { kind: 'publish-site', site: siteId, purpose }, 'none');
}

/** A standing grant in the receiving owner's declaration counts as the person's approval. */
function grantFor(runtime: Runtime, request: ResourceRequest) {
  const receiver = runtime.owner(request.to);
  const targets: Record<ResourceRequest['ask']['kind'], string> = {
    instance: '',
    work: '',
    'publish-site': request.ask.kind === 'publish-site' ? request.ask.site : '',
    'update-app': request.ask.kind === 'update-app' ? request.ask.app : '',
  };
  const target = targets[request.ask.kind];
  return receiver.grants.find(grant => grant.to === request.from && grant.action === request.ask.kind && (grant.target === target || grant.target === '*'));
}

async function approvedOrAwaiting(runtime: Runtime, request: ResourceRequest, summary: string) {
  const grant = grantFor(runtime, request);
  if (!grant) {
    await journalRequest(runtime, request, 'request-accepted', `${summary}; awaiting a person's approval`);
    return { ...request, status: 'awaiting-create-approval' as const };
  }
  const by = `standing grant in ${request.to}'s declaration (${grant.action} ${grant.target} for ${grant.to})`;
  await journalRequest(runtime, request, 'request-accepted', `${summary}; approved by ${by}`);
  return { ...request, status: 'create-approved' as const, approvals: [...request.approvals, { step: 'create' as const, by, at: new Date().toISOString() }] };
}

async function decidePublish(runtime: Runtime, request: ResourceRequest) {
  if (request.ask.kind !== 'publish-site') throw new Error('not_a_publish_request');
  const owner = runtime.truenasOwner(request.to);
  const site = owner.domain.sites.find(candidate => candidate.id === (request.ask as { site: string }).site);
  if (!site || site.source !== request.from) {
    const reason = site ? `runtime refused: ${request.from} is not the source of ${site.id}` : `runtime refused: unknown site ${request.ask.site}`;
    await journalRequest(runtime, request, 'request-refused', reason);
    return runtime.requests.save({ ...request, status: 'declined', reason });
  }
  const notebook = runtime.notebook(owner.id);
  await notebook.ensure(await runtime.text(`charters/${owner.id}.md`));
  const snapshot = await refreshWorkspace(runtime, owner);
  const brief = publishDecisionBrief(request, site, await notebook.orientation(), snapshot, rosterText(runtime.declarations, owner.id));
  const decision = (await runtime.hire(owner.id, { role: 'owner', model: owner.model, directory: owner.workspace, title: `${request.id}: decide publish`, brief, schema: PublishDecision })).value;
  if (decision.decision === 'decline') {
    await journalRequest(runtime, request, 'request-declined', decision.reply);
    return runtime.requests.save({ ...request, status: 'declined', publishDecision: decision, reason: decision.reply });
  }
  return runtime.requests.save(await approvedOrAwaiting(runtime, { ...request, publishDecision: decision }, `publish ${site.id}`));
}

/** The receiving owner decides. The runtime then checks the decision against the domain's rules before a person sees it. */
export async function decide(runtime: Runtime, requestId: string) {
  const request = await runtime.requests.get(requestId);
  requireStatus(request, 'pending-owner');
  return DECIDERS[request.ask.kind](runtime, request);
}

async function decideInstance(runtime: Runtime, request: ResourceRequest) {
  const owner = runtime.incusOwner(request.to);
  const notebook = runtime.notebook(owner.id);
  await notebook.ensure(await runtime.text(`charters/${owner.id}.md`));
  const snapshot = await refreshWorkspace(runtime, owner);
  const brief = requestDecisionBrief(request, await notebook.orientation(), snapshot, rosterText(runtime.declarations, owner.id));
  const decision = (await runtime.hire(owner.id, { role: 'owner', model: owner.model, directory: owner.workspace, title: `${request.id}: decide`, brief, schema: OwnerDecision })).value;
  if (decision.decision === 'decline') {
    await journalRequest(runtime, request, 'request-declined', decision.reply);
    return runtime.requests.save({ ...request, status: 'declined', decision, reason: decision.reply });
  }
  try {
    await checkCreate(owner, runtime.managed, { remote: decision.remote, image: decision.image, nameSuffix: decision.nameSuffix });
  } catch (error) {
    const reason = `runtime refused the owner's plan: ${error instanceof Error ? error.message : error}`;
    await journalRequest(runtime, request, 'request-refused', reason);
    return runtime.requests.save({ ...request, status: 'declined', decision, reason });
  }
  return runtime.requests.save(await approvedOrAwaiting(runtime, { ...request, decision }, `${decision.image} on ${decision.remote}`));
}

const DECIDERS: Record<ResourceAsk['kind'], Step> = {
  instance: decideInstance,
  'publish-site': decidePublish,
  'update-app': async (runtime, request) => runtime.requests.save(await approvedOrAwaiting(runtime, request, describeAsk(request.ask))),
  work: decideWork,
};

function approval(step: 'create' | 'delete', by: string) {
  return { step, by, at: new Date().toISOString() };
}

/** A person approves a create; `withDelete` also approves deleting it on release. Only records the decision. */
export async function approveCreate(runtime: Runtime, requestId: string, by: string, withDelete: boolean) {
  const approved = await runtime.requests.update(requestId, request => {
    requireStatus(request, 'awaiting-create-approval');
    return { ...request, status: 'create-approved', leaseIncludesDelete: withDelete,
      approvals: [...request.approvals, approval('create', by)] };
  });
  await journalRequest(runtime, approved, 'create-approved', `by ${by}${withDelete ? ' (delete on release pre-approved)' : ''}`);
  return approved;
}

export async function approveDelete(runtime: Runtime, requestId: string, by: string) {
  const approved = await runtime.requests.update(requestId, request => {
    requireStatus(request, 'awaiting-delete-approval');
    return { ...request, status: 'delete-approved', approvals: [...request.approvals, approval('delete', by)] };
  });
  await journalRequest(runtime, approved, 'delete-approved', `by ${by}`);
  return approved;
}

/** Denying a create ends the request; denying a delete keeps the instance and says so. */
export async function denyRequest(runtime: Runtime, requestId: string, by: string, reason: string) {
  const denied = await runtime.requests.update(requestId, request => {
    const statuses: Partial<Record<ResourceRequest['status'], ResourceRequest['status']>> = {
      'awaiting-create-approval': 'denied', 'awaiting-delete-approval': 'provisioned',
    };
    const status = statuses[request.status];
    if (!status) throw new Error(`request_not_awaiting_approval: ${request.id} is ${request.status}`);
    return { ...request, status, reason: `denied by ${by}: ${reason}` };
  });
  await journalRequest(runtime, denied, 'request-denied', `${by}: ${reason}`);
  return denied;
}

type FollowUp = (runtime: Runtime, request: ResourceRequest) => Promise<{ ok: boolean; summary: string }>;

/** Build clippy for Linux in the sandbox, run it in the lent instance, and check it wrote a PNG. */
const distroSmoke: FollowUp = async (runtime, request) => {
  const owner = runtime.repositoryOwner(request.from);
  const instance = `${request.instance!.remote}:${request.instance!.name}`;
  const buildDirectory = await mkdtemp(join(tmpdir(), 'owners-smoke-'));
  try {
    const build = await runSandboxed('go', ['build', '-o', join(buildDirectory, 'clippy'), '.'], {
      cwd: owner.workspace, writable: [buildDirectory], env: { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' },
    });
    if (build.exitCode !== 0) return { ok: false, summary: `build failed: ${build.output.slice(-400)}` };
    await runtime.incus.run(['exec', instance, '--', 'sh', '-c', 'for i in $(seq 30); do systemctl is-system-running --quiet 2>/dev/null && break; sleep 1; done; true']);
    await runtime.incus.run(['file', 'push', join(buildDirectory, 'clippy'), `${instance}/usr/local/bin/clippy`, '--mode', '0755']);
    const os = (await runtime.incus.run(['exec', instance, '--', 'sh', '-c', '. /etc/os-release; echo "$PRETTY_NAME"'])).trim();
    await runtime.incus.run(['exec', instance, '--', 'clippy', '-output', '/tmp/smoke.png', 'hello from onionsoup'], INCUS_LIMITS.commandTimeoutMs);
    const magic = (await runtime.incus.run(['exec', instance, '--', 'sh', '-c', 'head -c 8 /tmp/smoke.png | od -An -tx1 | tr -d " \\n"; echo; stat -c %s /tmp/smoke.png'])).trim().split('\n');
    const isPng = magic[0] === '89504e470d0a1a0a';
    return { ok: isPng, summary: `${os}: clippy ran; output ${isPng ? 'is a PNG' : 'is NOT a PNG'} (${magic[1]} bytes)` };
  } catch (error) {
    return { ok: false, summary: `smoke failed: ${(error instanceof Error ? error.message : String(error)).split('\n').slice(0, 3).join(' ')}` };
  } finally {
    await rm(buildDirectory, { recursive: true, force: true });
  }
};

export const FOLLOW_UPS: Record<string, FollowUp> = { 'distro-smoke': distroSmoke };

/** What each follow-up really does, so a requesting owner describes its purpose accurately. */
export const FOLLOW_UP_DESCRIPTIONS: Record<string, string> = {
  'distro-smoke': 'The host builds clippy as a static linux/amd64 binary in its sandbox (CGO_ENABLED=0), pushes only the binary into the instance, runs it once to render a PNG, and checks the PNG magic bytes. Nothing is installed in the instance and it needs no network.',
};

async function executePublish(runtime: Runtime, request: ResourceRequest) {
  try {
    const result = await publishSite(runtime, request);
    await journalRequest(runtime, request, 'published', `${(request.ask as { site: string }).site} at ${result.commit.slice(0, 8)} (previous kept as ${result.previous})`);
    return runtime.requests.save({ ...request, status: 'published', published: { ...result, at: new Date().toISOString() } });
  } catch (error) {
    const reason = `publish failed: ${error instanceof Error ? error.message.split('\n')[0] : error}`;
    await journalRequest(runtime, request, 'publish-failed', reason);
    return runtime.requests.save({ ...request, status: 'interrupted', reason });
  }
}

async function executeUpdate(runtime: Runtime, request: ResourceRequest) {
  try {
    const settled = await updateApp(runtime, request, {
      jobId: request.operation?.checkpoint?.jobId,
      onJobStarted: async jobId => {
        request.operation!.checkpoint = { ...request.operation!.checkpoint, jobId };
        await runtime.requests.checkpoint(request.id, { jobId });
      },
    });
    await journalRequest(runtime, request, 'app-updated', `${describeAsk(request.ask)}: ${settled}`);
    return runtime.requests.save({ ...request, status: 'updated', reason: settled });
  } catch (error) {
    const reason = `update failed: ${error instanceof Error ? error.message.split('\n')[0] : error}`;
    await journalRequest(runtime, request, 'attention', `${describeAsk(request.ask)}: ${reason}; a person should look`);
    return runtime.requests.save({ ...request, status: 'interrupted', reason });
  }
}

async function executeCreate(runtime: Runtime, request: ResourceRequest) {
  return CREATORS[request.ask.kind](runtime, request);
}

async function executeInstance(runtime: Runtime, request: ResourceRequest) {
  const owner = runtime.incusOwner(request.to);
  const decision = request.decision!;
  try {
    const name = await checkCreate(owner, runtime.managed, decision);
    request.operation!.checkpoint = { instance: { remote: decision.remote, name, image: decision.image } };
    await runtime.requests.checkpoint(request.id, request.operation!.checkpoint);
    const instance = await createInstance(runtime.incus, owner, runtime.managed, { remote: decision.remote, image: decision.image, nameSuffix: decision.nameSuffix }, { id: request.id, requestedBy: request.from });
    await journalRequest(runtime, request, 'instance-created', `${instance.remote}:${instance.name}`);
    return runtime.requests.save({ ...request, status: 'provisioned', instance });
  } catch (error) {
    const reason = `create failed: ${error instanceof Error ? error.message.split('\n')[0] : error}`;
    await journalRequest(runtime, request, 'create-failed', reason);
    return runtime.requests.save({ ...request, status: 'interrupted', reason });
  }
}

const CREATORS: Record<ResourceAsk['kind'], Step> = {
  instance: executeInstance,
  'publish-site': executePublish,
  'update-app': executeUpdate,
  work: async () => { throw new Error('work_request_has_no_create_step'); },
};

async function runFollowUp(runtime: Runtime, request: ResourceRequest) {
  const followUp = FOLLOW_UPS[request.followUp];
  const result = followUp ? await followUp(runtime, request) : { ok: false, summary: `unknown_follow_up: ${request.followUp}` };
  await journalRequest(runtime, request, 'follow-up', `${request.followUp}: ${result.ok ? 'ok' : 'FAILED'}: ${result.summary}`);
  const released = request.leaseIncludesDelete ? 'delete-approved' : 'awaiting-delete-approval';
  return runtime.requests.save({ ...request, followUpResult: { ...result, at: new Date().toISOString() }, status: released });
}

async function executeDelete(runtime: Runtime, request: ResourceRequest) {
  const owner = runtime.incusOwner(request.to);
  try {
    await deleteInstance(runtime.incus, owner, runtime.managed, request.instance!.remote, request.instance!.name);
    await journalRequest(runtime, request, 'instance-deleted', `${request.instance!.remote}:${request.instance!.name}`);
    return runtime.requests.save({ ...request, status: 'deleted' });
  } catch (error) {
    const reason = `delete failed: ${error instanceof Error ? error.message.split('\n')[0] : error}`;
    await journalRequest(runtime, request, 'delete-failed', reason);
    return runtime.requests.save({ ...request, status: 'interrupted', reason });
  }
}

type Step = (runtime: Runtime, request: ResourceRequest) => Promise<ResourceRequest>;

/** What the runtime does for each request state it owns. States waiting for a person are absent. */
export const REQUEST_STEPS: Partial<Record<ResourceRequest['status'], Step>> = {
  'work-running': trackDelegatedWork,
  'pending-owner': (runtime, request) => decide(runtime, request.id),
  'create-approved': executeCreate,
  provisioned: async (runtime, request) => (request.followUpResult || request.followUp === 'none' ? request : runFollowUp(runtime, request)),
  'delete-approved': executeDelete,
};

export function requestCanRun(request: ResourceRequest) {
  if (request.retry && Date.parse(request.retry.nextAt) > Date.now()) return false;
  if (request.operation?.runner !== undefined && requestRunnerIsAlive(request.operation.runner)) return false;
  if (request.status === 'provisioned') return !request.followUpResult && request.followUp !== 'none';
  return Boolean(REQUEST_STEPS[request.status]);
}

const EFFECT_FREE = new Set<ResourceRequest['status']>(['pending-owner', 'work-running']);

function requestFailure(request: ResourceRequest, error: unknown): ResourceRequest {
  const operation = { ...request.operation!, runner: undefined };
  const attempts = (request.retry?.attempts ?? 0) + 1;
  const shouldRetry = EFFECT_FREE.has(operation.stage) && attempts < REQUEST_LIMITS.decisionAttempts;
  const delay = Math.min(REQUEST_LIMITS.retryMaxMs, REQUEST_LIMITS.retryBaseMs * 2 ** (attempts - 1));
  return { ...request, operation, status: shouldRetry ? operation.stage : 'interrupted',
    retry: EFFECT_FREE.has(operation.stage) ? { attempts, nextAt: new Date(Date.now() + delay).toISOString() } : undefined,
    reason: `request_step_failed: ${error instanceof Error ? error.message : String(error)}` };
}

/** Run one request to its next gate, isolating failures from every other request. */
export async function processRequest(runtime: Runtime, id: string, onProgress: (request: ResourceRequest) => void = () => {}) {
  for (;;) {
    const request = await runtime.requests.get(id);
    const step = REQUEST_STEPS[request.status];
    if (!step || !requestCanRun(request)) return;
    const operation = { id: randomUUID(), stage: request.status, startedAt: new Date().toISOString(), runner: process.pid,
      checkpoint: request.operation?.stage === request.status ? request.operation.checkpoint : undefined };
    const active = await runtime.requests.update(id, current => {
      if (current.status !== request.status || current.operation?.runner !== undefined) return current;
      return { ...current, operation };
    });
    if (active.operation?.id !== operation.id) return;
    try {
      await step(runtime, active);
      const finished = await runtime.requests.update(id, current => {
        if (current.operation?.id !== operation.id) throw new Error('request_operation_changed');
        return { ...current, retry: undefined, operation: { ...current.operation, runner: undefined } };
      });
      if (finished.status === request.status && Boolean(finished.followUpResult) === Boolean(request.followUpResult)) return;
      onProgress(finished);
    } catch (error) {
      const failed = await runtime.requests.update(id, latest => {
        if (latest.operation?.id !== operation.id) return latest;
        return requestFailure(latest, error);
      });
      onProgress(failed);
      return;
    }
  }
}

/** CLI convenience: every request progresses even when an earlier request fails. */
export async function processRequests(runtime: Runtime, onProgress: (request: ResourceRequest) => void = () => {},
  onError: (id: string, error: unknown) => void = (id, error) => console.warn(`request_unavailable: ${id}`, error)) {
  for (const request of await runtime.requests.list()) {
    try {
      await processRequest(runtime, request.id, onProgress);
    } catch (error) {
      onError(request.id, error);
    }
  }
}
