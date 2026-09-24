import { ImplementationReport, Plan, Verdict } from './artifacts.ts';
import { implementBrief, planBrief, reviewBrief } from './briefs.ts';
import { requireFreelancer, requireWorkflow, type Craft, type WorkflowDeclaration } from './declarations.ts';
import { advanceDeskPublication, DESK_WORKFLOW } from './desk-changes.ts';
import { pickModel } from './families.ts';
import type { HumanNote, WorkItem, WorkStatus } from './ledger.ts';
import { answerQuestions, recordLearnings } from './owner.ts';
import { advanceRebase, REBASE_WORKFLOW } from './rebase.ts';
import type { Runtime } from './runtime.ts';
import { commitWorktree, createWorktree, diffAgainstBase, git, refreshCheckout, resetWorktree, verificationPassed, verify } from './workspace.ts';

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

const implement: Step = async (runtime, item, workflow) => {
  const owner = runtime.repositoryFor(item);
  if (!item.plan || !item.planApproval) throw new Error('plan_not_approved');
  const { path, branch } = await createWorktree(owner, runtime.worktreesRoot, item.id, item.repairOf?.previousHead);
  if (item.resetForPlan) {
    await resetWorktree(owner, path, item.repairOf?.previousHead);
    item.resetForPlan = false;
    await runtime.ledger.update(item.id, current => ({ ...current, resetForPlan: false }));
  }
  const hired = await freelancer(runtime, 'implementation');
  const report = await runtime.hireFor(item, 'implement', 'implementation', {
    role: 'implementer', model: hired.model, directory: path, title: `${item.id}: implement ${item.implementations.length + 1}`,
    brief: implementBrief(item, item.plan, await knowledgeFor(runtime, item), hired.rubric), schema: ImplementationReport,
  });
  const diff = await diffAgainstBase(owner, path, item.repairOf?.previousHead);
  const verification = await verify(owner, path, runtime.toolsDirectory);
  const implemented = { ...item, worktree: path, branch, implementations: [...item.implementations, { report, diffStat: diff.stat, verification }] };
  await runtime.notebook(item.owner).journal({ kind: 'implement', workItem: item.id, model: hired.model, outcome: verificationPassed(verification) ? 'verified' : 'verification-failed', note: diff.stat.split('\n').at(-1) });
  if (!diff.stat) return transition(implemented, 'failed', 'implementer_changed_nothing');
  if (verificationPassed(verification)) return transition(implemented, 'reviewing');
  if (revisionsUsed(implemented) >= workflow.review.maxRevisions) return transition(implemented, 'failed', 'verification_failed_after_revisions');
  return transition(implemented, 'implementing');
};

function revisionsUsed(item: WorkItem) {
  return Math.max(0, item.implementations.length - (item.revisionStart ?? 0) - 1);
}

function familiesOf(item: WorkItem, stages: readonly string[]) {
  return stages.map(stage => item.hires.filter(hire => hire.stage === stage && hire.craft !== 'owner' && hire.outcome === 'delivered').at(-1)?.family).filter((family): family is string => Boolean(family));
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
  const verdict = await runtime.hireFor(item, 'review', 'review', {
    role: 'reviewer', model: hired.model, directory: item.worktree, title: `${item.id}: review ${item.verdicts.length + 1}`,
    brief: reviewBrief(item, item.plan, diff.patch, verification, await knowledgeFor(runtime, item, true), hired.rubric), schema: Verdict,
  });
  await runtime.notebook(item.owner).journal({ kind: 'review', workItem: item.id, model: hired.model, outcome: verdict.decision, note: verdict.summary });
  return DECISIONS[verdict.decision]({ ...item, verdicts: [...item.verdicts, verdict] }, workflow);
};

function commitMessage(item: WorkItem) {
  const lastDelivered = (stage: string) => item.hires.filter(hire => hire.stage === stage && hire.craft !== 'owner' && hire.outcome === 'delivered').at(-1)?.model ?? 'unknown';
  return [
    item.proposal.title,
    '',
    item.plan?.summary ?? item.proposal.goal,
    '',
    `Work-item: ${item.id}`,
    `Owner: ${item.owner}`,
    `Planned-by: ${lastDelivered('plan')}`,
    `Implemented-by: ${lastDelivered('implement')}`,
    `Reviewed-by: ${lastDelivered('review')}`,
    `Plan-approved-by: ${item.planApproval?.by ?? 'unknown'}`,
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

const SPECIAL_WORKFLOWS: Record<string, (runtime: Runtime, itemId: string, onProgress: (item: WorkItem) => void) => Promise<WorkItem>> = {
  [REBASE_WORKFLOW]: advanceRebase,
  [DESK_WORKFLOW]: advanceDeskPublication,
};

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

export async function approvePlan(runtime: Runtime, itemId: string, by: string, note?: string) {
  const approved = await runtime.ledger.update(itemId, item => {
    requireAwaitingApproval(item);
    const humanNotes = note ? [...item.humanNotes, humanNote('approval', by, note)] : item.humanNotes;
    return { ...transition(item, 'implementing'), humanNotes, planApproval: { by, at: new Date().toISOString(), note } };
  });
  await runtime.notebook(approved.owner).journal({ kind: 'plan-approved', workItem: itemId, note: `${by}${note ? `: ${note}` : ''}` });
  return approved;
}

export async function revisePlan(runtime: Runtime, itemId: string, by: string, feedback: string) {
  const revised = await runtime.ledger.update(itemId, item => {
    requireAwaitingApproval(item);
    return { ...transition(item, 'planning'), humanNotes: [...item.humanNotes, humanNote('plan-feedback', by, feedback)] };
  });
  await runtime.notebook(revised.owner).journal({ kind: 'plan-feedback', workItem: itemId, note: `${by}: ${feedback}` });
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

async function recoverItem(runtime: Runtime, itemId: string, by: string, kind: 'resume' | 'retry') {
  const expected = kind === 'resume' ? 'interrupted' : 'failed';
  const recovered = await runtime.ledger.update(itemId, item => {
    if (item.status !== expected || item.activeRunner) throw new Error(`not_${expected}: ${item.status}`);
    const status = recoveryStage(item);
    return {
      ...transition(item, status),
      revisionStart: kind === 'retry' ? item.implementations.length : item.revisionStart,
      humanNotes: [...item.humanNotes, humanNote(kind, by, `continue from ${status}`)],
    };
  });
  await runtime.notebook(recovered.owner).journal({ kind: kind === 'resume' ? 'resumed' : 'retried', workItem: itemId, note: `${by}: continue from ${recovered.status}` });
  return recovered;
}

/** Record a person's recovery decision; the daemon executes the preserved stage on its next tick. */
export function resumeItem(runtime: Runtime, itemId: string, by: string) {
  return recoverItem(runtime, itemId, by, 'resume');
}

export function retryItem(runtime: Runtime, itemId: string, by: string) {
  return recoverItem(runtime, itemId, by, 'retry');
}

const CANCELLABLE = new Set<WorkStatus>([
  'proposed', 'planning', 'awaiting-plan-approval', 'implementing', 'reviewing', 'landing',
  'awaiting-push-approval', 'interrupted', 'failed', 'landed',
]);

/** Queued work and waiting gates can be cancelled; an active effect must finish first. */
export async function cancelItem(runtime: Runtime, itemId: string, by: string, reason: string) {
  const cancelled = await runtime.ledger.update(itemId, item => {
    if (item.activeRunner) throw new Error('work_item_active');
    if (item.status === 'landed' && item.publication) throw new Error('published_work_cannot_cancel');
    if (!CANCELLABLE.has(item.status)) throw new Error(`not_cancellable: ${item.status}`);
    return {
      ...transition(item, 'cancelled', reason),
      humanNotes: [...item.humanNotes, humanNote('cancellation', by, reason)],
    };
  });
  await runtime.notebook(cancelled.owner).journal({ kind: 'work-cancelled', workItem: itemId, note: `${by}: ${reason}` });
  return cancelled;
}
