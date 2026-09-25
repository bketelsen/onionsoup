import { ImplementationReport, Plan, Verdict } from './artifacts.ts';
import { findingsText, implementBrief, planBrief, reviewBrief, type PreviousReview } from './briefs.ts';
import { requireFreelancer, requireWorkflow, type Craft, type WorkflowDeclaration } from './declarations.ts';
import { advanceDeskPublication, DESK_WORKFLOW } from './desk-changes.ts';
import { pickModel } from './families.ts';
import type { HumanNote, Implementation, WorkItem, WorkStatus } from './ledger.ts';
import { answerQuestions, recordLearnings } from './owner.ts';
import { advanceRebase, REBASE_WORKFLOW } from './rebase.ts';
import { OWNER_CHANGE_WORKFLOW, tellOwner } from './plan-work.ts';
import type { Runtime } from './runtime.ts';
import {
  changesSince, commitWorktree, createWorktree, diffAgainstBase, git, refreshCheckout, removeIgnoredFiles, resetWorktree,
  snapshotTree, verificationPassed, verify, WORKSPACE_LIMITS,
} from './workspace.ts';

type Step = (runtime: Runtime, item: WorkItem, workflow: WorkflowDeclaration) => Promise<WorkItem>;

async function freelancer(runtime: Runtime, craft: Craft, excludedFamilies: readonly string[] = []) {
  const declaration = requireFreelancer(runtime.declarations, craft);
  const choice = pickModel(runtime.declarations.families, declaration.models, excludedFamilies);
  return { ...choice, rubric: await runtime.text(declaration.rubric) };
}

async function notebookFor(runtime: Runtime, item: WorkItem) {
  return runtime.notebook(item.owner).orientation();
}

/** The part of the owner's notebook an implementer or reviewer uses: the domain, its conventions, the person's decisions. */
async function knowledgeFor(runtime: Runtime, item: WorkItem, withCharter = false) {
  return runtime.notebook(item.owner).read([...(withCharter ? ['CHARTER' as const] : []), 'MAP', 'WISDOM', 'decisions']);
}

function transition(item: WorkItem, status: WorkStatus, reason?: string): WorkItem {
  return { ...item, status, reason };
}

const plan: Step = async (runtime, item, workflow) => {
  const owner = runtime.repositoryFor(item);
  await refreshCheckout(owner);
  const directory = item.repairOf
    ? (await createWorktree(owner, runtime.worktreesRoot, item.id, item.repairOf.previousHead)).path
    : owner.workspace;
  if (item.repairOf) await resetForPlan(runtime, item, directory);
  const hired = await freelancer(runtime, 'planning');
  const hirePlanner = async (current: WorkItem) => runtime.hireFor(current, 'plan', 'planning', {
    role: 'planner', model: hired.model, directory, title: `${item.id}: plan`,
    brief: planBrief(current, await notebookFor(runtime, current), hired.rubric), schema: Plan,
  });
  let drafted = await hirePlanner(item);
  if (workflow.plan.consultOwner && drafted.questionsForOwner.length && !item.ownerAnswers) {
    item.ownerAnswers = await answerQuestions(runtime, item, drafted.questionsForOwner);
    drafted = await hirePlanner(item);
  }
  await runtime.notebook(item.owner).journal({ kind: 'plan', workItem: item.id, model: hired.model, note: drafted.summary });
  return { ...transition(item, 'awaiting-plan-approval'), plan: drafted, planApproval: undefined };
};

async function resetForPlan(runtime: Runtime, item: WorkItem, path: string) {
  if (!item.resetForPlan) return;
  await resetWorktree(runtime.repositoryFor(item), path, item.repairOf?.previousHead);
  item.resetForPlan = false;
  await runtime.ledger.update(item.id, current => ({ ...current, resetForPlan: false }));
}

const implement: Step = async (runtime, item, workflow) => {
  const owner = runtime.repositoryFor(item);
  if (!item.plan || !item.planApproval) throw new Error('plan_not_approved');
  const { path, branch } = await createWorktree(owner, runtime.worktreesRoot, item.id, item.repairOf?.previousHead);
  await resetForPlan(runtime, item, path);
  const hired = await freelancer(runtime, 'implementation');
  const report = await runtime.hireFor(item, 'implement', 'implementation', {
    role: 'implementer', model: hired.model, directory: path, title: `${item.id}: implement ${item.implementations.length + 1}`,
    brief: implementBrief(item, item.plan, await knowledgeFor(runtime, item), hired.rubric), schema: ImplementationReport,
  });
  const diff = await diffAgainstBase(owner, path, item.repairOf?.previousHead);
  await removeIgnoredFiles(path);
  const tree = await snapshotTree(path);
  const verification = await verify(owner, path, runtime.toolsDirectory);
  const implementation: Implementation = { report, diffStat: diff.stat, verification, tree };
  const implemented = { ...item, worktree: path, branch, implementations: [...item.implementations, implementation] };
  await runtime.notebook(item.owner).journal({ kind: 'implement', workItem: item.id, model: hired.model, outcome: verificationPassed(verification) ? 'verified' : 'verification-failed', note: diff.stat.split('\n').at(-1) });
  if (!diff.stat) return transition(implemented, 'failed', 'implementer_changed_nothing');
  if (verificationPassed(verification)) return transition(implemented, 'reviewing');
  if (revisionsUsed(implemented) >= workflow.review.maxRevisions) return transition(implemented, 'failed', 'verification_failed_after_revisions');
  return transition(implemented, 'implementing');
};

function revisionsUsed(item: WorkItem) {
  return Math.max(0, item.implementations.length - (item.revisionStart ?? 0) - 1);
}

/** The freelancer who last delivered for a stage (the owner's own hires do not count). */
function lastDelivered(item: WorkItem, stage: string) {
  return item.hires.filter(hire => hire.stage === stage && hire.craft !== 'owner' && hire.outcome === 'delivered').at(-1);
}

function familiesOf(item: WorkItem, stages: readonly string[]) {
  return stages.map(stage => lastDelivered(item, stage)?.family).filter((family): family is string => Boolean(family));
}

/**
 * The round before this one when it asked for changes, with the diff since the implementation it reviewed: the
 * last one before the current that passed verification (only those reach review). Without both trees, none.
 */
async function previousReviewOf(item: WorkItem): Promise<PreviousReview | undefined> {
  const verdict = item.verdicts.at(-1);
  const currentTree = item.implementations.at(-1)?.tree;
  const reviewed = item.implementations.slice(0, -1).filter(implementation => verificationPassed(implementation.verification)).at(-1);
  if (verdict?.decision !== 'revise' || !currentTree || !reviewed?.tree) return undefined;
  const changes = await changesSince(item.worktree!, reviewed.tree, currentTree);
  return {
    round: item.verdicts.length, reviewer: lastDelivered(item, 'review')?.model ?? 'unknown', verdict,
    changesSince: changes?.slice(0, WORKSPACE_LIMITS.diffChars),
  };
}

const DECISIONS: Record<Verdict['decision'], (item: WorkItem, workflow: WorkflowDeclaration) => WorkItem> = {
  approve: item => transition(item, 'landing'),
  revise: (item, workflow) => revisionsUsed(item) >= workflow.review.maxRevisions
    ? transition(item, 'failed', 'revision_limit_reached')
    : transition(item, 'implementing'),
  replan: (item, workflow) => item.replans >= workflow.review.maxReplans
    ? transition(item, 'failed', 'replan_limit_reached')
    : { ...transition(item, 'planning'), replans: item.replans + 1, planApproval: undefined, resetForPlan: true, revisionStart: item.implementations.length },
};

const review: Step = async (runtime, item, workflow) => {
  const owner = runtime.repositoryFor(item);
  if (!item.plan || !item.worktree) throw new Error('nothing_to_review');
  const excluded = familiesOf(item, workflow.review.familyDiffersFrom);
  const hired = await freelancer(runtime, 'review', excluded);
  const diff = await diffAgainstBase(owner, item.worktree, item.repairOf?.previousHead);
  const verification = item.implementations.at(-1)?.verification ?? [];
  const knowledge = await knowledgeFor(runtime, item, true);
  const brief = reviewBrief(item, item.plan, diff.patch, verification, knowledge, hired.rubric, await previousReviewOf(item));
  const verdict = await runtime.hireFor(item, 'review', 'review', {
    role: 'reviewer', model: hired.model, directory: item.worktree, title: `${item.id}: review ${item.verdicts.length + 1}`,
    brief, schema: Verdict,
  });
  await runtime.notebook(item.owner).journal({ kind: 'review', workItem: item.id, model: hired.model, outcome: verdict.decision, note: verdict.summary });
  return DECISIONS[verdict.decision]({ ...item, verdicts: [...item.verdicts, verdict] }, workflow);
};

/** A landing over review findings says so in the commit: the reviewer did not approve it, a person did. */
function overrideTrailers(item: WorkItem) {
  return item.humanNotes.filter(note => note.kind === 'override').map(note => `Landed-over-findings-by: ${note.by}`);
}

function commitMessage(item: WorkItem) {
  const modelOf = (stage: string) => lastDelivered(item, stage)?.model ?? 'unknown';
  return [
    item.proposal.title,
    '',
    item.plan?.summary ?? item.proposal.goal,
    '',
    `Work-item: ${item.id}`,
    `Owner: ${item.owner}`,
    `Planned-by: ${modelOf('plan')}`,
    `Implemented-by: ${modelOf('implement')}`,
    `Reviewed-by: ${modelOf('review')}`,
    `Plan-approved-by: ${item.planApproval?.by ?? 'unknown'}`,
    ...overrideTrailers(item),
  ].join('\n');
}

/** The owner lands locally: a commit on the work item's branch. Publishing is a separate, explicit step. */
const land: Step = async (runtime, item) => {
  if (!item.worktree) throw new Error('nothing_to_land');
  const isClean = !(await git(item.worktree, ['status', '--porcelain'])).trim();
  const landedCommit = isClean
    ? await previouslyLanded(item)
    : await commitWorktree(item.worktree, commitMessage(item));
  await runtime.notebook(item.owner).journal({ kind: 'land', workItem: item.id, outcome: landedCommit.slice(0, 8) });
  return { ...transition(item, 'landed'), landedCommit };
};

async function previouslyLanded(item: WorkItem) {
  const message = await git(item.worktree!, ['log', '-1', '--format=%B']);
  if (!message.split('\n').includes(`Work-item: ${item.id}`)) throw new Error('nothing_to_land');
  return (await git(item.worktree!, ['rev-parse', 'HEAD'])).trim();
}

const STEPS: Partial<Record<WorkStatus, Step>> = {
  proposed: plan,
  planning: plan,
  implementing: implement,
  reviewing: review,
  landing: land,
};

const TERMINAL: readonly WorkStatus[] = ['landed', 'failed'];

/** An owner's plan is worked on in its session; the runtime only publishes what the session proposed. */
async function advanceOwnerChange(runtime: Runtime, itemId: string) {
  const item = await runtime.ledger.get(itemId);
  return isRunnable(item) ? advanceDeskPublication(runtime, itemId) : item;
}

const SPECIAL_WORKFLOWS: Record<string, (runtime: Runtime, itemId: string, onProgress: (item: WorkItem) => void) => Promise<WorkItem>> = {
  [REBASE_WORKFLOW]: advanceRebase,
  [DESK_WORKFLOW]: advanceDeskPublication,
  [OWNER_CHANGE_WORKFLOW]: advanceOwnerChange,
};

/** Statuses the runtime moves on its own; everything else waits for a person, an owner session, or is finished. */
const RUNNABLE: readonly WorkStatus[] = ['proposed', 'planning', 'implementing', 'reviewing', 'landing'];

const RUNNABLE_BY_WORKFLOW: Record<string, (item: WorkItem) => boolean> = {
  [OWNER_CHANGE_WORKFLOW]: item => item.status === 'landing' && Boolean(item.deskPublication),
};

/** Whether the daemon advances this item now. */
export function isRunnable(item: WorkItem) {
  if (item.activeRunner) return false;
  const runnable = RUNNABLE_BY_WORKFLOW[item.workflow] ?? (candidate => RUNNABLE.includes(candidate.status));
  return runnable(item);
}

/** Advance a work item until it reaches a human gate or ends. */
export async function advance(runtime: Runtime, itemId: string, onProgress: (item: WorkItem) => void = () => {}) {
  let item = await runtime.ledger.get(itemId);
  const special = SPECIAL_WORKFLOWS[item.workflow];
  if (special) return special(runtime, itemId, onProgress);
  const workflow = requireWorkflow(runtime.declarations, item.workflow);
  let step = STEPS[item.status];
  while (step) {
    const expectedStatus = item.status;
    const current = await runtime.ledger.update(item.id, latest => {
      if (latest.status !== expectedStatus || latest.activeRunner) throw new Error('work_item_changed');
      const status = latest.status === 'proposed' ? 'planning' : latest.status;
      return { ...latest, status, resumeStatus: status, activeRunner: process.pid };
    });
    try {
      item = await step(runtime, current, workflow);
    } catch (error) {
      item = transition(current, 'failed', error instanceof Error ? error.message : String(error));
    }
    item = await runtime.ledger.save({ ...item, activeRunner: undefined });
    onProgress(item);
    step = STEPS[item.status];
  }
  if (TERMINAL.includes(item.status)) {
    const priorHireCount = item.hires.length;
    await recordLearnings(runtime, item).catch(error => onProgress({ ...item, reason: `${item.reason ?? ''} (learnings failed: ${error instanceof Error ? error.message : error})` }));
    const learningHires = item.hires.slice(priorHireCount);
    item = await runtime.ledger.update(item.id, current => ({
      ...current, hires: [...current.hires, ...learningHires],
    }));
  }
  await runtime.notebook(item.owner).commit(`journal ${item.id}`);
  return item;
}

function humanNote(kind: HumanNote['kind'], by: string, note: string): HumanNote {
  return { kind, by, at: new Date().toISOString(), note };
}

function requireAwaitingApproval(item: WorkItem) {
  if (item.status !== 'awaiting-plan-approval' || item.activeRunner) throw new Error(`not_awaiting_plan_approval: ${item.status}`);
}

/** Where approved work goes next: freelancers implement a change plan; an owner's plan runs in its own session. */
const APPROVED_STATUS: Record<string, WorkStatus> = { [OWNER_CHANGE_WORKFLOW]: 'working' };

export async function approvePlan(runtime: Runtime, itemId: string, by: string, note?: string) {
  const approved = await runtime.ledger.update(itemId, item => {
    requireAwaitingApproval(item);
    const humanNotes = note ? [...item.humanNotes, humanNote('approval', by, note)] : item.humanNotes;
    const status = APPROVED_STATUS[item.workflow] ?? 'implementing';
    return { ...transition(item, status), humanNotes, planApproval: { by, at: new Date().toISOString(), note } };
  });
  await runtime.notebook(approved.owner).journal({ kind: 'plan-approved', workItem: itemId, note: `${by}${note ? `: ${note}` : ''}` });
  return approved;
}

/** The owner hears a sent-back plan in the session it planned in; freelancer planners read it from the item. */
const PLAN_FEEDBACK: Record<string, (runtime: Runtime, item: WorkItem, by: string, feedback: string) => Promise<void>> = {
  [OWNER_CHANGE_WORKFLOW]: (runtime, item, by, feedback) => tellOwner(runtime, item, 'plan-revise',
    `${by} sent your plan ${item.id} "${item.proposal.title}" back: ${feedback}. Revise it and submit it again with onionsoup_submit_plan with item "${item.id}".`),
};

export async function revisePlan(runtime: Runtime, itemId: string, by: string, feedback: string) {
  const revised = await runtime.ledger.update(itemId, item => {
    requireAwaitingApproval(item);
    return { ...transition(item, 'planning'), humanNotes: [...item.humanNotes, humanNote('plan-feedback', by, feedback)] };
  });
  await runtime.notebook(revised.owner).journal({ kind: 'plan-feedback', workItem: itemId, note: `${by}: ${feedback}` });
  await PLAN_FEEDBACK[revised.workflow]?.(runtime, revised, by, feedback);
  return revised;
}

const REJECTABLE: readonly WorkStatus[] = ['proposed', 'awaiting-plan-approval'];

export async function rejectPlan(runtime: Runtime, itemId: string, by: string, reason: string) {
  const rejected = await runtime.ledger.update(itemId, item => {
    if (!REJECTABLE.includes(item.status) || item.activeRunner) throw new Error(`not_rejectable: ${item.status}`);
    return { ...transition(item, 'rejected', reason), humanNotes: [...item.humanNotes, humanNote('rejection', by, reason)] };
  });
  await runtime.notebook(rejected.owner).journal({ kind: 'plan-rejected', workItem: itemId, note: `${by}: ${reason}` });
  return rejected;
}

const RECOVERABLE_STEPS = new Set<WorkStatus>(['planning', 'implementing', 'reviewing', 'landing', 'landed']);

function recoveryStage(item: WorkItem): WorkStatus {
  if (item.resumeStatus && RECOVERABLE_STEPS.has(item.resumeStatus)) return item.resumeStatus;
  return item.workflow === REBASE_WORKFLOW || item.planApproval ? 'implementing' : 'planning';
}

const RETRY_STAGES: Record<string, WorkStatus> = {
  revision_limit_reached: 'implementing',
  replan_limit_reached: 'planning',
};

function retryState(item: WorkItem) {
  const status = RETRY_STAGES[item.reason ?? ''] ?? recoveryStage(item);
  const needsNewPlan = item.reason === 'replan_limit_reached';
  return {
    ...transition(item, status), replans: 0, revisionStart: item.implementations.length,
    resetForPlan: needsNewPlan || item.resetForPlan,
    planApproval: needsNewPlan ? undefined : item.planApproval,
  };
}

/** The person's words when they give them, else what the runtime resumes; either way the next hire reads it. */
function recoveryNote(status: WorkStatus, note?: string) {
  return note?.trim() ? `${note.trim()} (continue from ${status})` : `continue from ${status}`;
}

async function recoverItem(runtime: Runtime, itemId: string, by: string, kind: 'resume' | 'retry', note?: string) {
  const expected = kind === 'resume' ? 'interrupted' : 'failed';
  const recovered = await runtime.ledger.update(itemId, item => {
    if (item.status !== expected || item.activeRunner) throw new Error(`not_${expected}: ${item.status}`);
    const resumed = kind === 'retry' ? retryState(item) : transition(item, recoveryStage(item));
    return {
      ...resumed,
      humanNotes: [...item.humanNotes, humanNote(kind, by, recoveryNote(resumed.status, note))],
    };
  });
  await runtime.notebook(recovered.owner).journal({ kind: kind === 'resume' ? 'resumed' : 'retried', workItem: itemId, note: `${by}: ${recoveryNote(recovered.status, note)}` });
  return recovered;
}

/** Record a person's recovery decision; the daemon executes the preserved stage on its next tick. */
export function resumeItem(runtime: Runtime, itemId: string, by: string, note?: string) {
  return recoverItem(runtime, itemId, by, 'resume', note);
}

export function retryItem(runtime: Runtime, itemId: string, by: string, note?: string) {
  return recoverItem(runtime, itemId, by, 'retry', note);
}

const CANCELLABLE = new Set<WorkStatus>([
  'proposed', 'planning', 'awaiting-plan-approval', 'working', 'implementing', 'reviewing', 'landing',
  'awaiting-push-approval', 'interrupted', 'failed', 'landed',
]);

/** Queued work and waiting gates can be cancelled; an active effect must finish first. */
export async function cancelItem(runtime: Runtime, itemId: string, by: string, reason: string) {
  const cancelled = await runtime.ledger.update(itemId, item => {
    if (item.activeRunner) throw new Error('work_item_active');
    if (item.status === 'landed' && (item.publication || item.rebaseOf)) throw new Error('published_work_cannot_cancel');
    if (!CANCELLABLE.has(item.status)) throw new Error(`not_cancellable: ${item.status}`);
    return {
      ...transition(item, 'cancelled', reason),
      humanNotes: [...item.humanNotes, humanNote('cancellation', by, reason)],
    };
  });
  await runtime.notebook(cancelled.owner).journal({ kind: 'work-cancelled', workItem: itemId, note: `${by}: ${reason}` });
  return cancelled;
}

const LANDABLE_OVER_FINDINGS = 'revision_limit_reached';

/** Only work that ran out of review rounds, with verification passing on what it would land. */
function requireLandableOverFindings(item: WorkItem) {
  if (item.activeRunner) throw new Error('work_item_active');
  if (item.status !== 'failed') throw new Error(`not_failed: ${item.status}`);
  if (item.reason !== LANDABLE_OVER_FINDINGS) throw new Error(`land_over_findings_not_revision_limit: ${item.reason}`);
  const latest = item.implementations.at(-1);
  if (!latest || !verificationPassed(latest.verification)) throw new Error('land_over_findings_unverified');
}

/** The findings the person landed over become work of their own, planned and approved like any other. */
function followUpProposal(item: WorkItem, by: string, note: string) {
  const findings = item.verdicts.at(-1)?.findings ?? [];
  if (!findings.length) return undefined;
  return {
    title: `Follow up review findings on ${item.proposal.title}`,
    goal: `Resolve the review findings that ${item.id} landed over:\n${findingsText(findings)}`,
    rationale: `${by} landed ${item.id} over its reviewer's findings after the revision limit: ${note}`,
    acceptance: ['Each listed finding is resolved, or the plan explains why it does not apply'],
    size: 'small' as const,
    repository: item.proposal.repository,
  };
}

/**
 * The person lands work whose review never converged, over the reviewer's last findings. The ordinary landing step
 * commits it; the override is on the item, in the journal and in the commit, and the findings become a follow-up.
 */
export async function landOverFindings(runtime: Runtime, itemId: string, by: string, note: string) {
  const reason = note.trim();
  if (!reason) throw new Error('land_over_findings_note_required');
  const item = await runtime.ledger.update(itemId, current => {
    requireLandableOverFindings(current);
    return {
      ...transition(current, 'landing'), resumeStatus: 'landing',
      humanNotes: [...current.humanNotes, humanNote('override', by, reason)],
    };
  });
  await runtime.notebook(item.owner).journal({ kind: 'landed-over-findings', workItem: itemId, note: `${by}: ${reason}` });
  const proposal = followUpProposal(item, by, reason);
  const followUp = proposal ? await runtime.ledger.create(item.owner, item.workflow, proposal) : undefined;
  return { item, followUp };
}
