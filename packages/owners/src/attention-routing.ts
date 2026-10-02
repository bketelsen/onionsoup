import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Attention } from './attention.ts';
import type { Initiative } from './initiatives.ts';
import type { AttentionProvenance } from './journal-record.ts';
import type { WorkItem } from './ledger.ts';
import { describeAsk, type ResourceRequest } from './requests.ts';
import type { Runtime } from './runtime.ts';

/** Unknown legacy notes stay conservative until host provenance can classify them. */
export function needsHumanDecision(entry: Attention) {
  return entry.status === 'open' && (!entry.provenance || entry.provenance.kind === 'human-decision');
}

interface Evidence {
  runtime: Runtime;
  items: WorkItem[];
  requests: ResourceRequest[];
  initiatives: Initiative[];
}

function legacyWorktree(entry: Attention, evidence: Evidence): AttentionProvenance | undefined {
  const outcomes = new Set(['kept-uncommitted', 'kept-unpublished', 'failed']);
  for (const item of evidence.items.filter(item => item.owner === entry.owner)) {
    const path = item.planWorktree ?? join(evidence.runtime.plansRoot, item.owner, item.id);
    const suffix = `. Look at it with \`git -C ${path} status\`; remove it with \`git worktree remove\` once nothing in it is needed.`;
    const notes = [
      `plan worktree ${path} was kept: it has uncommitted changes${suffix}`,
      `plan worktree ${path} was kept: it has commits no remote branch holds${suffix}`,
    ];
    const hasRecord = entry.workItem === item.id && outcomes.has(entry.outcome ?? '')
      && entry.note.startsWith(`plan worktree ${path} `);
    if (hasRecord || notes.includes(entry.note)) {
      return { kind: 'plan-worktree', workItem: item.id, path, generation: item.planWorktreeGeneration };
    }
  }
}

function legacyDelegation(entry: Attention, evidence: Evidence): AttentionProvenance | undefined {
  // This is the host journalRequest envelope, not an ID mentioned anywhere in model prose.
  for (const request of evidence.requests) {
    if (entry.owner !== request.from && entry.owner !== request.to) continue;
    const prefix = `${request.id} (${request.from} → ${request.to}): `;
    if (!entry.note.startsWith(prefix)) continue;
    const detail = entry.note.slice(prefix.length);
    const reply = request.publishDecision?.decision === 'decline' ? request.publishDecision.reply : undefined;
    const isDeclined = reply !== undefined
      && detail === `delegation declined: ${reply}; the person can resolve or redirect it`;
    const item = evidence.items.find(item => item.id === request.workItem && item.request === request.id && item.owner === request.to);
    const workPrefix = item ? `${item.id}: ` : undefined;
    const isWorkFailure = workPrefix && detail.startsWith(workPrefix)
      && /^(?:failed|rejected|cancelled|closed)(?:: .+)?$/s.test(detail.slice(workPrefix.length));
    if (isDeclined || isWorkFailure) return { kind: 'delegation', request: request.id, workItem: request.workItem };
  }
}

function legacyAppUpdate(entry: Attention, evidence: Evidence): AttentionProvenance | undefined {
  for (const request of evidence.requests) {
    if (request.ask.kind !== 'update-app') continue;
    if (entry.owner !== request.from && entry.owner !== request.to) continue;
    const prefix = `${request.id} (${request.from} → ${request.to}): ${describeAsk(request.ask)}: update failed: `;
    if (entry.note.startsWith(prefix) && entry.note.endsWith('; a person should look')) {
      return { kind: 'request-operation', request: request.id, operation: 'update-app', phase: 'execution' };
    }
  }
}

function legacyEscalation(entry: Attention, evidence: Evidence): AttentionProvenance | undefined {
  const matches: AttentionProvenance[] = [];
  for (const initiative of evidence.initiatives.filter(initiative => initiative.owner === entry.owner)) {
    for (const escalation of initiative.escalations) {
      const where = `${initiative.id}/${escalation.assignment}${escalation.item ? ` (work ${escalation.item})` : ''}`;
      const note = `${escalation.from} escalated (${escalation.kind}) on ${where}: ${escalation.note}`;
      if (entry.note === note) matches.push({ kind: 'escalation', initiative: initiative.id, escalation: escalation.id });
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function legacySuggestion(entry: Attention): AttentionProvenance | undefined {
  // Only the old host's work-mode envelope is recognizable. Attention-mode prose is ambiguous.
  if (/^proposed work(?: in [^:]+)?: .+ \(plan it with the owner in chat\)$/.test(entry.note)) {
    return { kind: 'suggestion', duty: 'legacy-survey' };
  }
}

const LEGACY_READERS = [legacyWorktree, legacyDelegation, legacyAppUpdate, legacyEscalation, legacySuggestion];

async function absentWorktree(provenance: Extract<AttentionProvenance, { kind: 'plan-worktree' }>) {
  try {
    await stat(provenance.path);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return 'plan_worktree_absent';
  }
}

type ClearEvidence = (provenance: AttentionProvenance, evidence: Evidence) => Promise<string | undefined>;
const CLEAR_EVIDENCE: Record<AttentionProvenance['kind'], ClearEvidence> = {
  suggestion: async () => undefined,
  maintenance: async () => undefined,
  'human-decision': async () => undefined,
  'request-operation': async (provenance, evidence) => {
    if (provenance.kind !== 'request-operation') return undefined;
    const request = evidence.requests.find(request => request.id === provenance.request);
    return request?.ask.kind === provenance.operation && request.status === 'updated'
      ? 'app_update_completed' : undefined;
  },
  'plan-worktree': async provenance => provenance.kind === 'plan-worktree' ? absentWorktree(provenance) : undefined,
  delegation: async (provenance, evidence) => {
    if (provenance.kind !== 'delegation') return undefined;
    const request = evidence.requests.find(request => request.id === provenance.request);
    if (!request) return undefined;
    if (request.status === 'completed') return 'delegation_completed';
    // A saved human cancellation is positive evidence; a different successful request is not.
    if (request.recovery.some(recovery => recovery.action === 'cancel')) return 'delegation_cancelled';
    const item = evidence.items.find(item => item.id === provenance.workItem && item.id === request.workItem);
    if (item?.status === 'cancelled') return 'delegation_work_cancelled';
  },
  escalation: async (provenance, evidence) => {
    if (provenance.kind !== 'escalation') return undefined;
    const initiative = evidence.initiatives.find(initiative => initiative.id === provenance.initiative);
    return initiative?.escalations.find(escalation => escalation.id === provenance.escalation)?.resolution
      ? 'escalation_resolved' : undefined;
  },
};

/** Reconcile the index only: retain journals, decisions, worktrees, requests and initiative records. */
export async function reconcileAttention(runtime: Runtime, entries: Attention[]) {
  if (!entries.length) return false;
  const [items, requests, initiatives] = await Promise.all([
    runtime.ledger.list(), runtime.requests.list(), runtime.initiatives.list(),
  ]);
  const evidence: Evidence = { runtime, items, requests, initiatives };
  let changed = false;
  for (const entry of entries) {
    if (entry.provenance?.kind === 'delegation' && entry.journal) {
      const corrected = legacyAppUpdate(entry, evidence);
      if (corrected?.kind === 'request-operation' && corrected.request === entry.provenance.request) {
        entry.provenance = corrected;
        changed = true;
      }
    }
    if (!entry.provenance && entry.journal) {
      const provenance = LEGACY_READERS.map(read => read(entry, evidence)).find(Boolean);
      if (provenance) {
        entry.provenance = provenance;
        changed = true;
      }
    }
    if (entry.status === 'resolved' || !entry.provenance) continue;
    const code = await CLEAR_EVIDENCE[entry.provenance.kind](entry.provenance, evidence);
    if (!code) continue;
    entry.status = 'resolved';
    entry.resolution = { code, at: new Date().toISOString() };
    changed = true;
  }
  return changed;
}
