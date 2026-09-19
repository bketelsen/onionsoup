import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { IssueSnapshot, validateAssessment } from './contracts.ts';
import { inputHash, triage, type RunRecord } from './triage.ts';
import { LocationInput, Commit } from './location-contracts.ts';
import { locateCode, type LocationRun } from './location-agent.ts';
import { validateLocationRun } from './location-record.ts';
import { liveModel } from './providers.ts';
import { PROMPT_VERSION } from './prompt.ts';
import { EVALUATION_MODEL } from './evaluation-policy.ts';
import { atomicJson } from './batch-store.ts';

export type Packet = {
  schemaVersion: 1; packetId: string; createdAt: string; finishedAt?: string;
  status: 'running' | 'completed' | 'partial' | 'failed'; stage: 'readiness' | 'location' | 'done';
  issue: IssueSnapshot; inputHash: string; repository: { name: string; commit: string };
  execution: { provider: 'copilot' | 'codex'; model: typeof EVALUATION_MODEL };
  reusedReadiness: boolean; readiness?: RunRecord; location?: LocationRun;
  locationDisposition: 'pending' | 'not_eligible' | 'completed' | 'not_located' | 'failed' | 'not_started';
  failure?: string;
};
export function validateReadiness(raw: unknown, issue: IssueSnapshot): RunRecord {
  const r = raw as RunRecord;
  if (!r || r.schemaVersion !== 2 || r.agent !== 'bug-readiness' || !z.string().uuid().safeParse(r.runId).success ||
      !IssueSnapshot.safeParse(r.input).success || r.inputHash !== inputHash(r.input) || r.inputHash !== inputHash(issue) ||
      !['running', 'completed', 'failed'].includes(r.status) || !r.provider || !r.model || !r.promptVersion ||
      !Array.isArray(r.events) || !z.iso.datetime().safeParse(r.startedAt).success ||
      (r.status !== 'running' && !z.iso.datetime().safeParse(r.finishedAt).success)) throw new Error('Invalid or mismatched readiness record');
  if (r.status === 'completed') validateAssessment(r.assessment, issue);
  else if (r.assessment) throw new Error('Unfinished readiness has an assessment');
  return r;
}
export function validatePacket(raw: unknown): Packet {
  const p = raw as Packet;
  if (!p || p.schemaVersion !== 1 || !z.string().uuid().safeParse(p.packetId).success ||
      !z.iso.datetime().safeParse(p.createdAt).success || !['running', 'completed', 'partial', 'failed'].includes(p.status) ||
      !['readiness', 'location', 'done'].includes(p.stage) || typeof p.reusedReadiness !== 'boolean' ||
      !['copilot', 'codex'].includes(p.execution?.provider) || p.execution.model !== EVALUATION_MODEL)
    throw new Error('Invalid packet');
  IssueSnapshot.parse(p.issue); Commit.parse(p.repository?.commit);
  if (p.inputHash !== inputHash(p.issue) || p.repository.name !== p.issue.repository) throw new Error('Packet input identity mismatch');
  if (p.readiness) validateReadiness(p.readiness, p.issue);
  if (p.readiness && (p.readiness.provider !== p.execution.provider || p.readiness.model !== p.execution.model)) throw new Error('Packet provider/model mismatch');
  if (p.reusedReadiness && p.readiness?.status !== 'completed') throw new Error('Invalid reused readiness');
  const eligible = p.readiness?.status === 'completed' && p.readiness.assessment?.kind === 'bug_report' && p.readiness.assessment.bug_readiness === 'ready';
  if (p.location) {
    const r = validateLocationRun(p.location);
    if (!eligible || r.input.parent.runId !== p.readiness!.runId || r.input.parent.inputHash !== p.inputHash ||
        r.input.parent.promptVersion !== p.readiness!.promptVersion || r.input.parent.summary !== p.readiness!.assessment!.summary ||
        r.input.repository.commit !== p.repository.commit || r.input.repository.name !== p.repository.name ||
        r.provider !== p.execution.provider || r.model !== p.execution.model) throw new Error('Packet handoff identity mismatch');
  }
  if (p.status === 'running') {
    if (p.stage === 'done' || p.finishedAt || p.locationDisposition !== 'pending') throw new Error('Invalid running packet');
  } else {
    if (p.stage !== 'done' || !z.iso.datetime().safeParse(p.finishedAt).success) throw new Error('Invalid packet termination');
    if (p.status === 'completed') {
      if (p.readiness?.status !== 'completed' || (eligible ? p.location?.status !== 'completed' || p.location.brief?.status !== 'located' || p.locationDisposition !== 'completed' : p.location !== undefined || p.locationDisposition !== 'not_eligible')) throw new Error('Invalid completed packet');
    } else if (p.status === 'partial') {
      if (!eligible || !['failed', 'not_located'].includes(p.locationDisposition) ||
          (p.locationDisposition === 'not_located' ? p.location?.brief?.status !== 'not_located' || p.location.status !== 'completed' : p.location?.status === 'completed')) throw new Error('Invalid partial packet');
    } else if (p.location || p.readiness?.status === 'completed' || p.locationDisposition !== 'not_started') throw new Error('Invalid failed packet');
  }
  return p;
}

// Escape prose as text; source quotations are inert fenced blocks with safe delimiters.
export { text } from '@onionsoup/runtime/text';
import { text } from '@onionsoup/runtime/text';
export const quote = (s: string) => { const fence = '`'.repeat(Math.max(3, ...[...s.matchAll(/`+/g)].map(m => m[0].length + 1))); return `${fence}text\n${s}\n${fence}`; };
export function packetMarkdown(raw: unknown) {
  const p = validatePacket(raw), r = p.readiness, a = r?.assessment, l = p.location;
  const lines = [`# Investigation packet: ${text(p.issue.repository)} #${p.issue.number}`, '', text(p.issue.title), '',
    `Status: **${p.status}** · Location: **${p.locationDisposition}**`, '',
    `[Original issue](https://github.com/${p.issue.repository}/issues/${p.issue.number}) · Snapshot: ${p.issue.updatedAt}`, '',
    `Pinned commit: ${p.repository.commit}`, '',
    'This packet describes the supplied snapshot. Locations are reading suggestions; tests were inspected, not executed. Classification makes no acceptance decision.', '',
    '## Readiness', ''];
  if (a) {
    lines.push(`Kind: ${a.kind} · Bug readiness: ${a.bug_readiness}`, '', text(a.summary), '');
    for (const e of a.evidence) lines.push(`### ${e.field}`, '', quote(e.quote), '');
    if (a.questions.length) lines.push('### Questions for the reporter', '', ...a.questions.map(q => `- ${text(q.question)}`), '');
  } else lines.push(text(r?.failure ?? p.failure ?? 'Readiness is unfinished; outcome unknown.'), '');
  lines.push('## Investigation starting points', '');
  if (l?.brief) {
    lines.push(text(l.brief.summary), '');
    if (l.brief.schemaVersion === 3) lines.push(`Bounded test search: **${l.brief.testSearch.status}** — ${text(l.brief.testSearch.reason)}`, '', 'Test relevance is model-assessed; it is not measured coverage.', '');
    for (const [label, pointers] of [['Code', l.brief.codePointers], ['Tests', l.brief.testPointers]] as const) {
      lines.push(`### ${label}`, '');
      if (!pointers.length) lines.push(`No ${label.toLowerCase()} location established within this bounded run.`, '');
      for (const c of pointers) {
        const url = `https://github.com/${p.repository.name}/blob/${p.repository.commit}/${c.path.split('/').map(encodeURIComponent).map(s => s.replace(/\(/g, '%28').replace(/\)/g, '%29')).join('/')}#L${c.startLine}-L${c.endLine}`;
        if ('relevance' in c) lines.push(`Model-assessed relevance: **${text(String(c.relevance))}**`, '');
        lines.push(`[${text(c.path)}:${c.startLine}–${c.endLine}](${url})`, '', text(c.reason), '', quote(c.quote), '');
      }
    }
    lines.push('### Uncertainties', '', ...l.brief.uncertainties.map(u => `- ${text(u)}`), '');
  } else lines.push(p.locationDisposition === 'not_eligible' ? 'Code-location does not apply to this readiness outcome.' : text(l?.failure ?? p.failure ?? 'Location is unfinished or has not started.'), '');
  lines.push('## Provenance', '', quote(JSON.stringify({ packetId: p.packetId, issueHash: p.inputHash,
    execution: p.execution, reusedReadiness: p.reusedReadiness, readinessRunId: r?.runId, readinessPrompt: r?.promptVersion,
    locationRunId: l?.runId, locationParentId: l?.input.parent.runId, locationPrompt: l?.promptVersion,
    locationRuntime: l?.runtimeHash, repositoryCommit: p.repository.commit,
    readinessUsage: r?.tokenUsage?.totals, locationUsage: l?.tokenUsage?.totals }, null, 2)), '',
    'Usage is reported per run; reused readiness is historical usage, not new spending. Quota consumed and billed cost are unknown.', '');
  return lines.join('\n');
}
export async function writePacket(directory: string, packet: Packet) {
  validatePacket(packet);
  await atomicJson(join(directory, 'packet.json'), packet);
  await writeFile(join(directory, 'packet.md'), packetMarkdown(packet), { mode: 0o600 });
}

export async function createPacket(raw: unknown, options: { directory: string; checkout: string; commit: string;
  provider: 'copilot' | 'codex'; readiness?: unknown; signal?: AbortSignal; modelFactory?: typeof liveModel }) {
  const issue = IssueSnapshot.parse(raw); Commit.parse(options.commit); options.signal?.throwIfAborted();
  const reused = options.readiness === undefined ? undefined : validateReadiness(options.readiness, issue);
  if (reused && (reused.status !== 'completed' || reused.provider !== options.provider || reused.model !== EVALUATION_MODEL || reused.promptVersion !== PROMPT_VERSION)) throw new Error('Reused readiness must match current prompt and selected Terra subscription');
  const p: Packet = { schemaVersion: 1, packetId: randomUUID(), createdAt: new Date().toISOString(), status: 'running', stage: 'readiness',
    issue, inputHash: inputHash(issue), repository: { name: issue.repository, commit: options.commit },
    execution: { provider: options.provider, model: EVALUATION_MODEL }, reusedReadiness: Boolean(reused),
    readiness: reused, locationDisposition: 'pending' };
  // Exclusive directory admission also prevents concurrent invocations overwriting a packet.
  await mkdir(options.directory, { mode: 0o700 });
  const save = () => writePacket(options.directory, p);
  await save();
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(240000)]) : AbortSignal.timeout(240000);
  let adapter: Awaited<ReturnType<typeof liveModel>> | undefined;
  const model = async () => {
    signal.throwIfAborted();
    adapter ??= await (options.modelFactory ?? liveModel)(EVALUATION_MODEL, options.provider);
    if (adapter.provider !== options.provider || adapter.modelId !== EVALUATION_MODEL) throw new Error('Provider/model mismatch');
    return adapter;
  };
  try {
    if (!p.readiness) p.readiness = await triage(issue, { ...await model(), signal,
      checkpoint: async r => { p.readiness = r; await save(); } });
    if (p.readiness.status !== 'completed') {
      p.status = 'failed'; p.failure = p.readiness.failure; p.locationDisposition = 'not_started';
    } else if (p.readiness.assessment!.kind !== 'bug_report' || p.readiness.assessment!.bug_readiness !== 'ready') {
      p.status = 'completed'; p.locationDisposition = 'not_eligible';
    } else {
      p.stage = 'location'; await save();
      const input = LocationInput.parse({ schemaVersion: 1, issue, repository: p.repository,
        parent: { runId: p.readiness.runId, inputHash: p.inputHash, promptVersion: p.readiness.promptVersion,
          kind: 'bug_report', bug_readiness: 'ready', summary: p.readiness.assessment!.summary } });
      p.location = await locateCode(input, { ...await model(), checkout: options.checkout, signal,
        checkpoint: async r => { p.location = r; await save(); } });
      p.locationDisposition = p.location.status === 'completed' ? p.location.brief!.status === 'located' ? 'completed' : 'not_located' : 'failed';
      p.status = p.locationDisposition === 'completed' ? 'completed' : 'partial';
      p.failure = p.location.failure;
    }
  } catch {
    p.failure = signal.aborted ? 'interrupted_or_timed_out' : 'stage_execution_or_persistence_error';
    p.status = p.stage === 'location' ? 'partial' : 'failed';
    p.locationDisposition = p.stage === 'location' ? 'failed' : 'not_started';
    // A checkpoint failure is not evidence that a finished agent failed. Preserve its outcome as running/unknown packet.
    if (p.location?.status === 'completed' || (p.stage === 'readiness' && p.readiness?.status === 'completed')) throw new Error('Packet persistence failed; inspect saved artifacts before starting a new attempt');
  }
  p.stage = 'done'; p.finishedAt = new Date().toISOString(); await save();
  return p;
}
