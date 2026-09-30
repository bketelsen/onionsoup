import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ProposedWork } from './artifacts.ts';
import { journalRequest } from './delegation.ts';
import { ChatOrigin } from './chat-origin.ts';
import { canChange } from './declarations.ts';
import { requestRunnerIsAlive } from './requests.ts';
import { withRecordLock } from './record-lock.ts';
import type { Runtime } from './runtime.ts';

export const ASK_HANDOFF_LIMITS = { textChars: 8_000, acceptanceItems: 12, recoveryAttempts: 3, recoveriesPerTick: 20 };
const boundedText = z.string().trim().min(1).max(ASK_HANDOFF_LIMITS.textChars);
export const AskWorkProposal = ProposedWork.extend({
  title: boundedText, goal: boundedText, rationale: boundedText,
  acceptance: z.array(boundedText).min(1).max(ASK_HANDOFF_LIMITS.acceptanceItems),
  repository: boundedText,
});

export const Answer = z.object({
  answer: z.string().describe('The direct answer, in your own voice'),
  observed: z.array(z.string()).describe('Facts you observed, each with its source (file, snapshot, date)'),
  inferred: z.array(z.string()).describe('What you infer from them, labelled as inference'),
  unknown: z.array(z.string()).describe('What you do not know and would need to find out'),
  proposedWork: AskWorkProposal.optional().describe('At most one repository work proposal, only when the caller explicitly requests follow-up. Never a claim of execution.'),
});
export type Answer = z.infer<typeof Answer>;
export const AskOrigin = ChatOrigin.extend({ sessionID: z.string().min(1), directory: z.string().min(1), messageID: z.string().min(1) });
export type AskOrigin = z.infer<typeof AskOrigin>;
const HandoffInput = z.object({ from: z.string(), to: z.string(), question: z.string(), origin: AskOrigin });
export type HandoffInput = z.infer<typeof HandoffInput>;
const Handoff = z.object({ version: z.literal(1), input: HandoffInput, answer: Answer, createdAt: z.string(),
  journal: z.object({ done: z.boolean(), attempts: z.number().int().nonnegative(), reason: z.string().optional() })
    .default({ done: false, attempts: 0 }),
  routing: z.object({ state: z.enum(['pending', 'routed', 'blocked']), attempts: z.number().int().nonnegative(),
    requestID: z.string().optional(), reason: z.string().optional() }).default({ state: 'pending', attempts: 0 }),
});

function identity(input: HandoffInput) {
  return createHash('sha256').update(JSON.stringify(HandoffInput.parse(input))).digest('hex');
}

function path(runtime: Runtime, input: HandoffInput) {
  return join(runtime.stateDirectory, 'handoffs', `ask-${identity(input)}.json`);
}

export async function readAskHandoff(runtime: Runtime, input: HandoffInput) {
  try {
    const record = Handoff.parse(JSON.parse(await readFile(path(runtime, input), 'utf8')));
    if (JSON.stringify(record.input) !== JSON.stringify(HandoffInput.parse(input))) throw new Error('handoff_identity_conflict');
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Persist the first valid answer before a request can become visible to the daemon. */
export async function saveAskHandoff(runtime: Runtime, input: HandoffInput, answer: Answer) {
  const record = Handoff.parse({ version: 1, input, answer, createdAt: new Date().toISOString() });
  return withRecordLock(`${path(runtime, input)}.lock`, async () => {
    const existing = await readAskHandoff(runtime, input);
    if (existing) return existing;
    await mkdir(join(runtime.stateDirectory, 'handoffs'), { recursive: true });
    const temporary = `${path(runtime, input)}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path(runtime, input));
    return record;
  });
}

async function writeHandoff(runtime: Runtime, input: HandoffInput, record: z.infer<typeof Handoff>) {
  const temporary = `${path(runtime, input)}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path(runtime, input));
}

async function openHandoffRequest(runtime: Runtime, input: HandoffInput, record: z.infer<typeof Handoff>) {
  const proposal = record.answer.proposedWork;
  if (!proposal) return undefined;
  return runtime.requests.openIdentified(`r-handoff-${identity(input)}`, input.from, input.to,
    { kind: 'work', purpose: proposal.goal, proposal }, 'none', ChatOrigin.parse(input.origin), () => {
      // Existing requests are adopted by identity even if declarations changed after creation.
      // Execution still rechecks authority through the ordinary request pipeline.
      runtime.owner(input.from);
      if (input.from === input.to) throw new Error('handoff_self_request');
      const receiver = runtime.owner(input.to);
      if (!canChange(receiver)) throw new Error(`owner_cannot_change: ${receiver.id}`);
      runtime.repositoryOwner(receiver.id, proposal.repository);
    });
}

/** Replay adopts the request's current state. Routing recovery never retries an effect or reopens rejected work. */
export async function routeAskHandoff(runtime: Runtime, input: HandoffInput) {
  const request = await routeRecordedHandoff(runtime, input);
  await repairHandoffJournal(runtime, input).catch(() => console.warn('handoff_journal_failed', identity(input)));
  return request;
}

const INVALID_ROUTES = new Set(['owner_cannot_change', 'not_your_repository', 'not_a_repository_owner',
  'which_repository', 'handoff_self_request', 'request_identity_conflict', 'request_identity_invalid', 'unknown owner']);

function reasonCode(error: unknown) {
  return error instanceof Error ? error.message.split(':')[0] : 'handoff_routing_failed';
}

async function routeRecordedHandoff(runtime: Runtime, input: HandoffInput) {
  return withRecordLock(`${path(runtime, input)}.lock`, async () => {
    const record = await readAskHandoff(runtime, input);
    if (!record) throw new Error('handoff_not_recorded');
    if (record.routing.state === 'routed') {
      if (!record.routing.requestID) return undefined;
      if (record.routing.requestID !== `r-handoff-${identity(input)}`) throw new Error('handoff_request_identity_conflict');
      return runtime.requests.get(record.routing.requestID);
    }
    if (record.routing.state === 'blocked') throw new Error(record.routing.reason ?? 'handoff_routing_blocked');
    try {
      const request = await openHandoffRequest(runtime, input, record);
      await writeHandoff(runtime, input, { ...record, routing: {
        state: 'routed', attempts: record.routing.attempts, requestID: request?.id,
      } });
      return request;
    } catch (error) {
      const attempts = record.routing.attempts + 1;
      await writeHandoff(runtime, input, { ...record, routing: {
        state: INVALID_ROUTES.has(reasonCode(error)) || attempts >= ASK_HANDOFF_LIMITS.recoveryAttempts ? 'blocked' : 'pending', attempts,
        reason: reasonCode(error),
      } });
      throw error;
    }
  });
}

/** Journal failure cannot undo the independently durable request link. */
async function repairHandoffJournal(runtime: Runtime, input: HandoffInput) {
  await withRecordLock(`${path(runtime, input)}.lock`, async () => {
    const record = await readAskHandoff(runtime, input);
    if (!record || record.routing.state !== 'routed' || record.journal.done
      || record.journal.attempts >= ASK_HANDOFF_LIMITS.recoveryAttempts) return;
    try {
      if (record.routing.requestID) {
        const request = await runtime.requests.get(record.routing.requestID);
        await journalRequest(runtime, request, 'request-opened', request.ask.purpose);
      }
      await writeHandoff(runtime, input, { ...record, journal: { done: true, attempts: record.journal.attempts } });
    } catch (error) {
      await writeHandoff(runtime, input, { ...record, journal: {
        done: false, attempts: record.journal.attempts + 1, reason: 'handoff_journal_failed',
      } });
      throw error;
    }
  });
}

export const HandoffStatus = z.object({
  state: z.enum(['none', 'pending', 'routed', 'blocked']), reason: z.string().optional(), requestID: z.string().optional(),
});
export type HandoffStatus = z.infer<typeof HandoffStatus>;

/** Preserve the paid answer even when a proposed action cannot be routed. */
export async function resolveAskHandoff(runtime: Runtime, input: HandoffInput) {
  try {
    const request = await routeAskHandoff(runtime, input);
    return { request, handoffStatus: HandoffStatus.parse({ state: request ? 'routed' : 'none', requestID: request?.id }) };
  } catch (error) {
    const record = await readAskHandoff(runtime, input).catch(() => undefined);
    return { request: undefined, handoffStatus: HandoffStatus.parse({
      state: record?.routing.state === 'pending' ? 'pending' : 'blocked', reason: reasonCode(error),
      requestID: record?.routing.requestID,
    }) };
  }
}

/** New explicit handoff records only; never reads old exchange notices or acknowledged attention. */
export async function recoverAskHandoffs(runtime: Runtime, onError: (id: string, error: unknown) => void) {
  const directory = join(runtime.stateDirectory, 'handoffs');
  const names = await readdir(directory).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  let attempted = 0;
  for (const name of names.filter(name => /^ask-[a-f0-9]{64}\.json$/.test(name)).sort()) {
    try {
      const record = Handoff.parse(JSON.parse(await readFile(join(directory, name), 'utf8')));
      const needsJournal = record.routing.state === 'routed' && !record.journal.done
        && record.journal.attempts < ASK_HANDOFF_LIMITS.recoveryAttempts;
      if (record.routing.state !== 'pending' && !needsJournal) continue;
      if (attempted >= ASK_HANDOFF_LIMITS.recoveriesPerTick) break;
      attempted++;
      await routeAskHandoff(runtime, record.input);
    } catch (error) {
      onError(name, error);
    }
  }
  return attempted;
}

const ConsultationClaim = z.object({ pid: z.number().int().positive(), token: z.string() });

/** Claim only model work; no lock is held during inference. A live claimant is never retried in parallel. */
export async function withAskConsultation<Output>(runtime: Runtime, input: HandoffInput, operation: () => Promise<Output>) {
  const claimPath = `${path(runtime, input)}.claim`;
  const token = randomUUID();
  const claimed = await withRecordLock(`${path(runtime, input)}.lock`, async () => {
    if (await readAskHandoff(runtime, input)) return false;
    const previous = await readFile(claimPath, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    });
    if (previous && requestRunnerIsAlive(ConsultationClaim.parse(JSON.parse(previous)).pid)) {
      throw new Error('handoff_consultation_in_progress');
    }
    const temporary = `${claimPath}.${token}.tmp`;
    await writeFile(temporary, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
    await rename(temporary, claimPath);
    return true;
  });
  try {
    return await operation();
  } finally {
    if (claimed) await withRecordLock(`${path(runtime, input)}.lock`, async () => {
      const contents = await readFile(claimPath, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return undefined;
      });
      if (!contents) return;
      const current = ConsultationClaim.parse(JSON.parse(contents));
      if (current.token === token) await unlink(claimPath).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    });
  }
}
