import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestDecisionBrief } from './briefs.ts';
import { rosterText } from './roster.ts';
import { checkCreate, createInstance, deleteInstance, INCUS_LIMITS } from './incus.ts';
import { refreshWorkspace } from './owner.ts';
import { OwnerDecision, requireStatus, type ResourceAsk, type ResourceRequest } from './requests.ts';
import type { Runtime } from './runtime.ts';
import { runSandboxed } from './sandbox.ts';

async function journalBoth(runtime: Runtime, request: ResourceRequest, kind: string, note: string) {
  for (const ownerId of new Set([request.from, request.to])) {
    const notebook = runtime.notebook(ownerId);
    await notebook.journal({ kind, note: `${request.id} (${request.from} → ${request.to}): ${note}` });
    await notebook.commit(`journal ${request.id}`);
  }
}

/** An owner asks another owner for an instance. The request waits for the receiving owner's decision. */
export async function requestInstance(runtime: Runtime, from: string, to: string, ask: ResourceAsk, followUp: string) {
  runtime.incusOwner(to);
  const request = await runtime.requests.open(from, to, ask, followUp);
  await journalBoth(runtime, request, 'request-opened', `${ask.image} for ${ask.purpose}`);
  return request;
}

/** The receiving owner decides. The runtime then checks the decision against the domain's rules before a person sees it. */
export async function decide(runtime: Runtime, requestId: string) {
  const request = await runtime.requests.get(requestId);
  requireStatus(request, 'pending-owner');
  const owner = runtime.incusOwner(request.to);
  const notebook = runtime.notebook(owner.id);
  await notebook.ensure(await runtime.text(`charters/${owner.id}.md`));
  const snapshot = await refreshWorkspace(runtime, owner);
  const brief = requestDecisionBrief(request, await notebook.orientation(), snapshot, rosterText(runtime.declarations, owner.id));
  const decision = (await runtime.hire(owner.id, { role: 'owner', model: owner.model, directory: owner.workspace, title: `${request.id}: decide`, brief, schema: OwnerDecision })).value;
  if (decision.decision === 'decline') {
    await journalBoth(runtime, request, 'request-declined', decision.reply);
    return runtime.requests.save({ ...request, status: 'declined', decision, reason: decision.reply });
  }
  try {
    await checkCreate(owner, runtime.managed, { remote: decision.remote, image: decision.image, nameSuffix: decision.nameSuffix });
  } catch (error) {
    const reason = `runtime refused the owner's plan: ${error instanceof Error ? error.message : error}`;
    await journalBoth(runtime, request, 'request-refused', reason);
    return runtime.requests.save({ ...request, status: 'declined', decision, reason });
  }
  await journalBoth(runtime, request, 'request-accepted', `${decision.image} on ${decision.remote}; awaiting a person's create approval`);
  return runtime.requests.save({ ...request, status: 'awaiting-create-approval', decision });
}

function approval(step: 'create' | 'delete', by: string) {
  return { step, by, at: new Date().toISOString() };
}

/** A person approves a create; `withDelete` also approves deleting it on release. Only records the decision. */
export async function approveCreate(runtime: Runtime, requestId: string, by: string, withDelete: boolean) {
  const request = await runtime.requests.get(requestId);
  requireStatus(request, 'awaiting-create-approval');
  await journalBoth(runtime, request, 'create-approved', `by ${by}${withDelete ? ' (delete on release pre-approved)' : ''}`);
  return runtime.requests.save({ ...request, status: 'create-approved', leaseIncludesDelete: withDelete, approvals: [...request.approvals, approval('create', by)] });
}

export async function approveDelete(runtime: Runtime, requestId: string, by: string) {
  const request = await runtime.requests.get(requestId);
  requireStatus(request, 'awaiting-delete-approval');
  await journalBoth(runtime, request, 'delete-approved', `by ${by}`);
  return runtime.requests.save({ ...request, status: 'delete-approved', approvals: [...request.approvals, approval('delete', by)] });
}

/** Denying a create ends the request; denying a delete keeps the instance and says so. */
export async function denyRequest(runtime: Runtime, requestId: string, by: string, reason: string) {
  const request = await runtime.requests.get(requestId);
  const next = request.status === 'awaiting-create-approval' ? 'denied' : request.status === 'awaiting-delete-approval' ? 'provisioned' : undefined;
  if (!next) throw new Error(`request_not_awaiting_approval: ${request.id} is ${request.status}`);
  await journalBoth(runtime, request, 'request-denied', `${by}: ${reason}`);
  return runtime.requests.save({ ...request, status: next, reason: `denied by ${by}: ${reason}` });
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

async function executeCreate(runtime: Runtime, request: ResourceRequest) {
  const owner = runtime.incusOwner(request.to);
  const decision = request.decision!;
  try {
    const instance = await createInstance(runtime.incus, owner, runtime.managed, { remote: decision.remote, image: decision.image, nameSuffix: decision.nameSuffix }, { id: request.id, requestedBy: request.from });
    await journalBoth(runtime, request, 'instance-created', `${instance.remote}:${instance.name}`);
    return runtime.requests.save({ ...request, status: 'provisioned', instance });
  } catch (error) {
    const reason = `create failed: ${error instanceof Error ? error.message.split('\n')[0] : error}`;
    await journalBoth(runtime, request, 'create-failed', reason);
    return runtime.requests.save({ ...request, status: 'failed', reason });
  }
}

async function runFollowUp(runtime: Runtime, request: ResourceRequest) {
  const followUp = FOLLOW_UPS[request.followUp];
  const result = followUp ? await followUp(runtime, request) : { ok: false, summary: `unknown_follow_up: ${request.followUp}` };
  await journalBoth(runtime, request, 'follow-up', `${request.followUp}: ${result.ok ? 'ok' : 'FAILED'}: ${result.summary}`);
  const released = request.leaseIncludesDelete ? 'delete-approved' : 'awaiting-delete-approval';
  return runtime.requests.save({ ...request, followUpResult: { ...result, at: new Date().toISOString() }, status: released });
}

async function executeDelete(runtime: Runtime, request: ResourceRequest) {
  const owner = runtime.incusOwner(request.to);
  try {
    await deleteInstance(runtime.incus, owner, runtime.managed, request.instance!.remote, request.instance!.name);
    await journalBoth(runtime, request, 'instance-deleted', `${request.instance!.remote}:${request.instance!.name}`);
    return runtime.requests.save({ ...request, status: 'deleted' });
  } catch (error) {
    const reason = `delete failed: ${error instanceof Error ? error.message.split('\n')[0] : error}`;
    await journalBoth(runtime, request, 'delete-failed', reason);
    return runtime.requests.save({ ...request, status: 'failed', reason });
  }
}

type Step = (runtime: Runtime, request: ResourceRequest) => Promise<ResourceRequest>;

/** What the runtime does for each request state it owns. States waiting for a person are absent. */
const REQUEST_STEPS: Partial<Record<ResourceRequest['status'], Step>> = {
  'pending-owner': (runtime, request) => decide(runtime, request.id),
  'create-approved': executeCreate,
  provisioned: async (runtime, request) => (request.followUpResult ? request : runFollowUp(runtime, request)),
  'delete-approved': executeDelete,
};

/** Move every request as far as it can go without a person. */
export async function processRequests(runtime: Runtime, onProgress: (request: ResourceRequest) => void = () => {}) {
  let moved = true;
  while (moved) {
    moved = false;
    for (const request of await runtime.requests.list()) {
      const step = REQUEST_STEPS[request.status];
      if (!step) continue;
      const next = await step(runtime, request);
      if (next.status !== request.status || next.followUpResult !== request.followUpResult) {
        moved = true;
        onProgress(next);
      }
    }
  }
}
