import { ImplementationReport, Plan, Verdict } from './artifacts.ts';
import { implementBrief, planBrief, reviewBrief } from './briefs.ts';
import { requireFreelancer, requireWorkflow, type Craft, type WorkflowDeclaration } from './declarations.ts';
import { pickModel } from './families.ts';
import type { HumanNote, WorkItem, WorkStatus } from './ledger.ts';
import { answerQuestions, recordLearnings } from './owner.ts';
import { advanceRebase, REBASE_WORKFLOW } from './rebase.ts';
import type { Runtime } from './runtime.ts';
import { commitWorktree, createWorktree, diffAgainstBase, refreshCheckout, resetWorktree, verificationPassed, verify } from './workspace.ts';

type Step = (runtime: Runtime, item: WorkItem, workflow: WorkflowDeclaration) => Promise<WorkItem>;

async function freelancer(runtime: Runtime, craft: Craft, excludedFamilies: readonly string[] = []) {
  const declaration = requireFreelancer(runtime.declarations, craft);
  const choice = pickModel(runtime.declarations.families, declaration.models, excludedFamilies);
  return { ...choice, rubric: await runtime.text(declaration.rubric) };
}

async function notebookFor(runtime: Runtime, item: WorkItem) {
  return runtime.notebook(item.owner).orientation();
}

function transition(item: WorkItem, status: WorkStatus, reason?: string): WorkItem {
  return { ...item, status, reason };
}

const plan: Step = async (runtime, item, workflow) => {
  const owner = runtime.repositoryOwner(item.owner);
  await refreshCheckout(owner);
  const hired = await freelancer(runtime, 'planning');
  const hirePlanner = async (current: WorkItem) => runtime.hireFor(current, 'plan', 'planning', {
    role: 'planner', model: hired.model, directory: owner.workspace, title: `${item.id}: plan`,
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
  const owner = runtime.repositoryOwner(item.owner);
  if (!item.plan || !item.planApproval) throw new Error('plan_not_approved');
  const { path, branch } = await createWorktree(owner, runtime.worktreesRoot, item.id);
  if (item.verdicts.at(-1)?.decision === 'replan') await resetWorktree(owner, path);
  const hired = await freelancer(runtime, 'implementation');
  const report = await runtime.hireFor(item, 'implement', 'implementation', {
    role: 'implementer', model: hired.model, directory: path, title: `${item.id}: implement ${item.implementations.length + 1}`,
    brief: implementBrief(item, item.plan, await notebookFor(runtime, item), hired.rubric), schema: ImplementationReport,
  });
  const diff = await diffAgainstBase(owner, path);
  const verification = await verify(owner, path);
  const implemented = { ...item, worktree: path, branch, implementations: [...item.implementations, { report, diffStat: diff.stat, verification }] };
  await runtime.notebook(item.owner).journal({ kind: 'implement', workItem: item.id, model: hired.model, outcome: verificationPassed(verification) ? 'verified' : 'verification-failed', note: diff.stat.split('\n').at(-1) });
  if (!diff.stat) return transition(implemented, 'failed', 'implementer_changed_nothing');
  if (verificationPassed(verification)) return transition(implemented, 'reviewing');
  if (revisionsUsed(implemented) > workflow.review.maxRevisions) return transition(implemented, 'failed', 'verification_failed_after_revisions');
  return transition(implemented, 'implementing');
};

function revisionsUsed(item: WorkItem) {
  return Math.max(0, item.implementations.length - 1);
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
    : { ...transition(item, 'planning'), replans: item.replans + 1, planApproval: undefined },
};

const review: Step = async (runtime, item, workflow) => {
  const owner = runtime.repositoryOwner(item.owner);
  if (!item.plan || !item.worktree) throw new Error('nothing_to_review');
  const excluded = familiesOf(item, workflow.review.familyDiffersFrom);
  const hired = await freelancer(runtime, 'review', excluded);
  const diff = await diffAgainstBase(owner, item.worktree);
  const verification = item.implementations.at(-1)?.verification ?? [];
  const verdict = await runtime.hireFor(item, 'review', 'review', {
    role: 'reviewer', model: hired.model, directory: item.worktree, title: `${item.id}: review ${item.verdicts.length + 1}`,
    brief: reviewBrief(item, item.plan, diff.patch, verification, await notebookFor(runtime, item), hired.rubric), schema: Verdict,
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
  const landedCommit = await commitWorktree(item.worktree, commitMessage(item));
  await runtime.notebook(item.owner).journal({ kind: 'land', workItem: item.id, outcome: landedCommit.slice(0, 8) });
  return { ...transition(item, 'landed'), landedCommit };
};

const STEPS: Partial<Record<WorkStatus, Step>> = {
  proposed: plan,
  planning: plan,
  implementing: implement,
  reviewing: review,
  landing: land,
};

const TERMINAL: readonly WorkStatus[] = ['landed', 'failed'];

/** Advance a work item until it reaches a human gate or ends. */
export async function advance(runtime: Runtime, itemId: string, onProgress: (item: WorkItem) => void = () => {}) {
  let item = await runtime.ledger.get(itemId);
  if (item.workflow === REBASE_WORKFLOW) return advanceRebase(runtime, itemId, onProgress);
  const workflow = requireWorkflow(runtime.declarations, item.workflow);
  if (item.status === 'interrupted') item = transition(item, item.planApproval ? 'implementing' : 'planning');
  let step = STEPS[item.status];
  while (step) {
    const current = item.status === 'proposed' ? transition(item, 'planning') : item;
    item = await runtime.ledger.save(current);
    try {
      item = await step(runtime, current, workflow);
    } catch (error) {
      item = transition(current, 'failed', error instanceof Error ? error.message : String(error));
    }
    item = await runtime.ledger.save(item);
    onProgress(item);
    step = STEPS[item.status];
  }
  if (TERMINAL.includes(item.status)) {
    await recordLearnings(runtime, item).catch(error => onProgress({ ...item, reason: `${item.reason ?? ''} (learnings failed: ${error instanceof Error ? error.message : error})` }));
    item = await runtime.ledger.save(item);
  }
  await runtime.notebook(item.owner).commit(`journal ${item.id}`);
  return item;
}

function humanNote(kind: HumanNote['kind'], by: string, note: string): HumanNote {
  return { kind, by, at: new Date().toISOString(), note };
}

async function requireAwaitingApproval(runtime: Runtime, itemId: string) {
  const item = await runtime.ledger.get(itemId);
  if (item.status !== 'awaiting-plan-approval') throw new Error(`not_awaiting_plan_approval: ${item.status}`);
  return item;
}

/** The human gate: nothing is implemented until a person approves the plan. An approval note travels to the implementer and reviewer. */
export async function approvePlan(runtime: Runtime, itemId: string, by: string, note?: string) {
  const item = await requireAwaitingApproval(runtime, itemId);
  const humanNotes = note ? [...item.humanNotes, humanNote('approval', by, note)] : item.humanNotes;
  const approved = { ...transition(item, 'implementing'), humanNotes, planApproval: { by, at: new Date().toISOString(), note } };
  await runtime.notebook(item.owner).journal({ kind: 'plan-approved', workItem: item.id, note: `${by}${note ? `: ${note}` : ''}` });
  return runtime.ledger.save(approved);
}

/** The middle option: send the plan back to the planner with a person's feedback; it returns to the gate. */
export async function revisePlan(runtime: Runtime, itemId: string, by: string, feedback: string) {
  const item = await requireAwaitingApproval(runtime, itemId);
  await runtime.notebook(item.owner).journal({ kind: 'plan-feedback', workItem: item.id, note: `${by}: ${feedback}` });
  return runtime.ledger.save({ ...transition(item, 'planning'), humanNotes: [...item.humanNotes, humanNote('plan-feedback', by, feedback)] });
}

const REJECTABLE: readonly WorkStatus[] = ['proposed', 'awaiting-plan-approval'];

/** A person can turn down a proposal before it is planned, or a plan at the gate. */
export async function rejectPlan(runtime: Runtime, itemId: string, by: string, reason: string) {
  const item = await runtime.ledger.get(itemId);
  if (!REJECTABLE.includes(item.status)) throw new Error(`not_rejectable: ${item.status}`);
  await runtime.notebook(item.owner).journal({ kind: 'plan-rejected', workItem: item.id, note: `${by}: ${reason}` });
  return runtime.ledger.save({ ...transition(item, 'rejected', reason), humanNotes: [...item.humanNotes, humanNote('rejection', by, reason)] });
}

/** Interrupted work is never replayed on its own; a person resumes it, and the runtime continues at its next tick. */
export async function resumeItem(runtime: Runtime, itemId: string, by: string) {
  const item = await runtime.ledger.get(itemId);
  if (item.status !== 'interrupted') throw new Error(`not_interrupted: ${item.status}`);
  const status: WorkStatus = item.workflow === REBASE_WORKFLOW || item.planApproval ? 'implementing' : 'planning';
  await runtime.notebook(item.owner).journal({ kind: 'resumed', workItem: item.id, note: `${by}: continue from ${status}` });
  return runtime.ledger.save(transition(item, status, `resumed by ${by}`));
}
