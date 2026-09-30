import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { Runtime } from '../packages/owners/src/runtime.ts';
import { AdmissionRecord, DeploymentIntent, listAdmissions } from '../packages/owners/src/deployment-admission.ts';
import { deliveredExchangeNoticeProof } from '../packages/owners/src/exchange-notices.ts';
import { createAdmission, readOpencodeEndpoint } from './deploy-admission.mjs';

import { fail, hash } from './admission-recovery-proof.mjs';
import { FailedToolSelection, FailedToolProof, proveFailedTool } from './failed-tool-admission-proof.mjs';
export { fail, hash } from './admission-recovery-proof.mjs';
const absolute = z.string().refine(value => isAbsolute(value) && resolve(value) === value);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const LEGACY_NOTICE_BUILD = 'b2db85b5fa46b1d8f6608ab6e1c3e29a75da0f95';
export const Selection = z.object({ root: absolute, state: absolute, config: absolute,
  surfaceUrl: z.string().url(), expectedOld: commit, expectedTarget: commit,
  sessions: z.array(z.string().regex(/^ses_[a-zA-Z0-9]+$/)).min(1).max(20),
  failedTool: FailedToolSelection.optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.sessions).size !== value.sessions.length || value.expectedOld === value.expectedTarget
    || (value.failedTool && !value.sessions.includes(value.failedTool.sessionID))) {
    context.addIssue({ code: 'custom', message: 'notice_recovery_selection_invalid' });
  }
});

export const EndpointIdentity = z.object({ instanceId: z.string(), surfacePid: z.number().int().positive(),
  surfaceStartTime: z.string(), opencodePid: z.number().int().positive(), opencodeStartTime: z.string(),
  url: z.string().url(), credentialDigest: digest }).strict();
export const RecoveryProof = z.object({ selection: Selection,
  manifests: z.array(z.object({ build: commit, digest }).strict()).length(2),
  endpoint: EndpointIdentity, leases: z.array(AdmissionRecord.extend({ alive: z.boolean() }).strict()),
  sessions: z.array(z.object({ sessionID: z.string(), directory: absolute, userID: z.string(), finalID: z.string(),
    noticeIDs: z.array(z.string()).min(1), transcriptDigest: digest, noticeDigest: digest }).strict()),
  failedTool: FailedToolProof.optional(),
}).strict().superRefine((proof, context) => {
  const sessions = [...proof.sessions.map(session => session.sessionID),
    ...(proof.failedTool ? [proof.failedTool.selection.sessionID] : [])].sort();
  if (hash(sessions) !== hash([...proof.selection.sessions].sort())
    || hash([proof.failedTool?.selection]) !== hash([proof.selection.failedTool])) {
    context.addIssue({ code: 'custom', message: 'notice_recovery_proof_selection_mismatch' });
  }
});

export function endpointIdentity(endpoint) {
  return { instanceId: endpoint.instanceId, surfacePid: endpoint.surfacePid,
    surfaceStartTime: endpoint.surfaceStartTime, opencodePid: endpoint.opencodePid,
    opencodeStartTime: endpoint.opencodeStartTime, url: endpoint.url,
    credentialDigest: hash([endpoint.username, endpoint.password]) };
}

export async function readContext(selection, statuses = ['armed', 'waiting']) {
  const intent = DeploymentIntent.parse(JSON.parse(await readFile(join(selection.state, 'deploy/pending.json'), 'utf8')));
  if (intent.targetBuildId !== selection.expectedTarget || !statuses.includes(intent.status)) {
    throw fail('notice_recovery_pending_mismatch');
  }
  const pointer = join(selection.root, 'current');
  const old = join(selection.root, 'releases', selection.expectedOld);
  if (!(await lstat(pointer)).isSymbolicLink() || await realpath(pointer) !== old) {
    throw fail('notice_recovery_pointer_mismatch');
  }
  const manifests = [];
  for (const build of [selection.expectedOld, selection.expectedTarget]) {
    const release = join(selection.root, 'releases', build);
    if (!(await lstat(release)).isDirectory() || await realpath(release) !== release) {
      throw fail('notice_recovery_release_invalid');
    }
    const bytes = await readFile(join(release, 'packages/surface/release-manifest.json'), 'utf8');
    if (JSON.parse(bytes).buildId !== build) throw fail('notice_recovery_manifest_mismatch');
    manifests.push({ build, digest: hash(bytes) });
  }
  return { selection, manifests };
}

export async function requestEndpoint(endpoint, path, directory) {
  const url = new URL(path, endpoint.url);
  url.searchParams.set('directory', directory);
  const authorization = `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString('base64')}`;
  const response = await fetch(url, { headers: { authorization }, signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw fail('notice_recovery_probe_unavailable');
  return response.json();
}

function completedRealTurn(messages) {
  const userIndex = messages.findLastIndex(message => message?.info?.role === 'user');
  const user = messages[userIndex]?.info;
  const last = messages.at(-1)?.info;
  if (userIndex < 0 || typeof user?.id !== 'string' || last?.role !== 'assistant'
    || last.parentID !== user.id || last.finish !== 'stop' || !Number.isFinite(last.time?.completed)) {
    throw fail('notice_recovery_real_turn_incomplete');
  }
  return { userID: user.id, finalID: last.id };
}

async function noticeProjection(runtime, target, messages, allowLegacy) {
  if (!Array.isArray(messages) || !messages.length) throw fail('notice_recovery_history_unavailable');
  let end = messages.length;
  const notices = [];
  while (end > 0) {
    const proof = await deliveredExchangeNoticeProof(runtime, target, messages[end - 1], { allowLegacy });
    if (!proof) break;
    notices.unshift(proof);
    end--;
  }
  if (!notices.length) throw fail('notice_recovery_tail_not_notice');
  const projected = messages.slice(0, end);
  const completed = completedRealTurn(projected);
  return { projected, proof: { ...target, ...completed, noticeIDs: notices.map(proof => proof.notice.id),
    transcriptDigest: hash(messages), noticeDigest: hash(notices) } };
}

export function selectedLeases(leases, selection, endpoint) {
  const live = leases.filter(lease => lease.alive);
  const sessions = live.map(lease => lease.kind.startsWith('chat:') ? lease.kind.slice(5) : undefined);
  if (live.length !== selection.sessions.length || new Set(sessions).size !== live.length
    || live.some(lease => lease.pid !== endpoint.opencodePid || lease.startTime !== endpoint.opencodeStartTime)
    || sessions.some(session => !selection.sessions.includes(session))) throw fail('notice_recovery_unexpected_lease');
  return live.sort((left, right) => left.id.localeCompare(right.id));
}

export async function assertNoWork(runtime) {
  await runtime.reloadDeclarations();
  if ((await runtime.ledger.list()).some(item => item.activeRunner)) throw fail('notice_recovery_active_work');
}

/** Reuse all existing deployment probes, projecting only proven trailing notices in memory. */
function recoveryLeases(leases, selection, endpoint, recovered) {
  if (!recovered) return selectedLeases(leases, selection, endpoint);
  if (leases.some(lease => lease.alive)) throw fail('notice_recovery_admissions_active');
  return [];
}

export async function probeNoticeAdmissions(selection, effects = {}, statuses, recovered = false) {
  const context = await readContext(selection, statuses);
  const endpointProbe = effects.endpoint ?? readOpencodeEndpoint;
  const endpoint = await endpointProbe(selection.state);
  const leases = recoveryLeases(await listAdmissions(selection.state), selection, endpoint, recovered);
  const runtime = await Runtime.open({ state: selection.state, declarations: selection.config });
  const snapshots = new Map();
  const request = effects.request ?? requestEndpoint;
  const identity = endpointIdentity(endpoint);
  try {
    await assertNoWork(runtime);
    const failedTool = selection.failedTool
      ? await proveFailedTool(selection.failedTool, selection.expectedOld, endpoint, request) : undefined;
    const admission = await createAdmission({ ...selection, admissionEffects: { ...effects,
      request: async (observedEndpoint, path, directory) => {
        if (hash(endpointIdentity(observedEndpoint)) !== hash(identity)) throw fail('notice_recovery_endpoint_changed');
        const response = await request(observedEndpoint, path, directory);
        const session = selection.sessions.find(id => path === `/session/${encodeURIComponent(id)}/message`);
        const childSession = selection.sessions.find(id => path === `/session/${encodeURIComponent(id)}/children`);
        if (childSession && childSession !== selection.failedTool?.sessionID && (!Array.isArray(response) || response.length)) throw fail('notice_recovery_has_children');
        if (!session || session === selection.failedTool?.sessionID) return response;
        const { projected, proof } = await noticeProjection(runtime, { sessionID: session, directory }, response,
          selection.expectedOld === LEGACY_NOTICE_BUILD);
        if (snapshots.has(session) && hash(snapshots.get(session)) !== hash(proof)) {
          throw fail('notice_recovery_evidence_changed');
        }
        snapshots.set(session, proof);
        return projected;
      },
    } });
    if (!await admission.bootstrapQuiet(selection.sessions, endpoint)) throw fail('notice_recovery_not_quiet');
    await assertNoWork(runtime);
    const checkedFailure = selection.failedTool
      ? await proveFailedTool(selection.failedTool, selection.expectedOld, endpoint, request) : undefined;
    if (hash([checkedFailure]) !== hash([failedTool])) throw fail('notice_recovery_evidence_changed');
    const after = await endpointProbe(selection.state);
    if (hash(endpointIdentity(after)) !== hash(identity)) throw fail('notice_recovery_endpoint_changed');
    const afterLeases = recoveryLeases(await listAdmissions(selection.state), selection, after, recovered);
    if (hash(afterLeases) !== hash(leases) || hash(await readContext(selection, statuses)) !== hash(context)) {
      throw fail('notice_recovery_evidence_changed');
    }
    if (snapshots.size + (failedTool ? 1 : 0) !== selection.sessions.length) throw fail('notice_recovery_evidence_incomplete');
    const proof = RecoveryProof.parse({ ...context, endpoint: identity, leases,
      ...(failedTool ? { failedTool } : {}),
      sessions: [...snapshots.values()].sort((left, right) => left.sessionID.localeCompare(right.sessionID)) });
    return { state: 'preview', digest: hash(proof), proof };
  } finally { runtime.close(); }
}
