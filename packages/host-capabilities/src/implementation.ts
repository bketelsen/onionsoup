import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Capability, CapabilityContext } from '@onionsoup/job-host';
import { readJson } from '@onionsoup/runtime/storage';
import { liveModel } from '@onionsoup/providers';
import { EVALUATION_MODEL } from '@onionsoup/providers/evaluation-policy';
import { hash } from '@onionsoup/repository-analysis/contracts';
import { validateChangeWorkflow, type ChangeWorkflow } from '@onionsoup/maintenance/proposal/record';
import { Proposal } from '@onionsoup/maintenance/proposal/contracts';
import { RepositoryProfile, Task, VerificationPlan } from '@onionsoup/implementation/project/repository-profile';
import { Runtime, type Dependency, type Job } from '@onionsoup/implementation/project/contracts';
import { proposeProject, acceptProject } from '@onionsoup/implementation/project/proposal';
import { executeProject } from '@onionsoup/implementation/project/recipe';
import { validateProject } from '@onionsoup/implementation/project/record';
import { provisionDependencies } from '@onionsoup/implementation/project/dependencies';
import { provisionGoDependencies } from '@onionsoup/implementation/project/go-dependencies';
import { prepareProjectPublication } from '@onionsoup/implementation/project/publication';
import { loadPublicationConfig } from '@onionsoup/implementation/publication/bundle';
import { approvePublication, publish } from '@onionsoup/implementation/publication/runtime';
import { ProposalResult, gitHead } from './maintenance.ts';

const execute = promisify(execFile);

/** Operator files that authorize implementation for one repository. All paths are resolved by the host, never by a request. */
export const ImplementationConfig = z.object({
  /** Repository profile JSON: allowed paths, toolchain pins, required checks. */
  profile: z.string().min(1),
  /** Pinned sandbox runtime JSON produced by the fixture or Go pin commands. */
  runtime: z.string().min(1),
  /** Publication configuration JSON with the draft-PR targets. */
  publication: z.string().min(1),
  /** Index into the publication targets. */
  target: z.number().int().min(0).default(0),
}).strict();
export type ImplementationConfig = z.infer<typeof ImplementationConfig>;

export type ImplementationRepository = { name: string; checkout?: string; implementation?: ImplementationConfig };

export type ImplementationOptions = {
  provider: 'copilot' | 'codex';
  repositories: ImplementationRepository[];
  modelFactory?: typeof liveModel;
  pipeline?: Partial<Pipeline>;
};

/** The pipeline steps, injectable so tests can exercise the capability seam without a sandbox. */
export type Pipeline = {
  propose: typeof proposeProject;
  accept: typeof acceptProject;
  execute: typeof executeProject;
  provisionNode: typeof provisionDependencies;
  provisionGo: typeof provisionGoDependencies;
  prepare: typeof prepareProjectPublication;
  approve: typeof approvePublication;
  publish: typeof publish;
};

const SafePath = Task.shape.allowedFiles.element;
const TaskDraft = z.object({
  title: Task.shape.title,
  request: Task.shape.request,
  allowedFiles: Task.shape.allowedFiles,
  context: Task.shape.context,
}).strict();

export const Approval = z.object({
  schemaVersion: z.literal(1),
  /** Where the task came from: a completed proposal, or a request typed by a person. */
  origin: z.enum(['proposal', 'request']).default('proposal'),
  proposalJobId: z.uuid().optional(),
  proposalHash: z.string().length(64).optional(),
  repository: z.string(),
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
  profileHash: z.string().length(64),
  reason: z.string().min(1).max(500),
  approvedAt: z.iso.datetime(),
  task: TaskDraft,
}).strict();
export type Approval = z.infer<typeof Approval>;

export const ApprovalResult = z.object({ approval: Approval }).strict();
export const ImplementResult = z.object({
  outcome: z.string(),
  headCommit: z.string().optional(),
  diff: z.string().optional(),
  workflow: z.json(),
}).strict();
export const PublishResult = z.object({ publicationId: z.string(), status: z.string(), pull: z.json().optional() }).strict();

const matches = (pattern: string, path: string) => (pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : pattern === path);
const DENIED = ['.github/**', '.onionsoup/**', 'go.mod', 'go.sum', 'package.json', 'package-lock.json', 'tsconfig.json', '.npmrc', 'resources/**'];

function citedPaths(workflow: ChangeWorkflow): { path: string; startLine: number; endLine: number }[] {
  const sources = workflow.preparation?.sources ?? [];
  return sources.map((source) => ({ path: source.path, startLine: source.startLine, endLine: source.endLine }));
}

/** Build the request text the implementation agents will read: the original report plus the accepted proposal. */
function requestText(workflow: ChangeWorkflow, proposal: Proposal): string {
  const issue = workflow.parent.issue;
  const lines = [
    `Accepted change proposal for ${issue.repository}#${issue.number}: ${issue.title}`,
    '',
    'Outcome: ' + proposal.outcome,
    '',
    'Changes:',
    ...proposal.changes.map((change) => `- ${change}`),
    '',
    'Acceptance criteria:',
    ...proposal.acceptanceCriteria.map((criterion) => `- ${criterion.id}: ${criterion.criterion}`),
    '',
    'Non-goals:',
    ...proposal.nonGoals.map((goal) => `- ${goal}`),
    '',
    'Original report:',
    issue.body,
  ];
  return lines.join('\n').slice(0, 12000);
}

function permittedBy(profile: RepositoryProfile) {
  const denied = [...DENIED, ...profile.changes.protected];
  return (path: string) => profile.changes.allowed.some((pattern) => matches(pattern, path)) && !denied.some((pattern) => matches(pattern, path));
}

function draftTask(workflow: ChangeWorkflow, proposal: Proposal, profile: RepositoryProfile, requested?: string[], override?: string) {
  const permitted = permittedBy(profile);
  const cited = citedPaths(workflow);
  const candidates = requested ?? [...new Set(cited.map((source) => source.path))];
  const rejected = candidates.filter((path) => !permitted(path));
  if (requested && rejected.length) throw new Error(`files_outside_profile:${rejected.join(',')}`);
  const allowedFiles = candidates.filter(permitted).slice(0, profile.changes.maximumFiles);
  if (!allowedFiles.length) throw new Error('no_allowed_files');
  let context = cited.filter((source) => allowedFiles.includes(source.path)).slice(0, 30);
  if (!context.length) context = [{ path: allowedFiles[0], startLine: 1, endLine: 1 }];
  const request = override ? `${requestText(workflow, proposal)}\n\nOperator override: ${override}` : requestText(workflow, proposal);
  return TaskDraft.parse({ title: workflow.parent.issue.title.slice(0, 140), request: request.slice(0, 40000), allowedFiles, context });
}

function verificationPlanFor(profile: RepositoryProfile, draft: z.infer<typeof TaskDraft>): VerificationPlan {
  const primary = draft.allowedFiles[0];
  const check = { id: 'task-primary-file-changed', kind: 'file-changed' as const, path: primary };
  if (profile.execution.adapter === 'go-module-v1') return VerificationPlan.parse({ schemaVersion: 1, adapter: 'go-module-v1', source: 'package main\n', checks: [check] });
  return VerificationPlan.parse({ schemaVersion: 1, adapter: 'node-typescript-v1', source: 'export {};\n', checks: [check] });
}

function mappingFor(proposal: Proposal, profile: RepositoryProfile, task: Task): Job['mapping'] {
  const checks = [...profile.verification.required, ...task.checks.map((check) => check.id)];
  if (!proposal.acceptanceCriteria.length) throw new Error('no_acceptance_criteria');
  return proposal.acceptanceCriteria.map((criterion) => ({ criterionId: criterion.id, checks }));
}

/** Typed requests are authoritative; the proposal agent should not stall on rendering boundaries. */
const REQUEST_SCOPE_NOTE = 'Scope note from the operator: this request is authoritative as written. The listed files are the whole scope. If edited data is shared by other pages or views, the change applies wherever it renders; do not ask about rendering boundaries or page-specific sources. Propose the change.';

/** Excerpt bounds the project proposal agent accepts per context entry. */
const EXCERPT_CHARS = 5000;
const MAX_EXCERPTS = 30;

/**
 * Context for a typed request: the allowed files themselves, at the base commit, in line-based chunks
 * small enough for the proposal agent, so it can see the code it is asked to change.
 */
async function fileContext(checkout: string, commit: string, files: string[], signal: AbortSignal) {
  const context: { path: string; startLine: number; endLine: number }[] = [];
  for (const path of files) {
    let text: string;
    try {
      text = (await execute('git', ['-C', checkout, 'show', `${commit}:${path}`], { signal, timeout: 10000, maxBuffer: 8000000 })).stdout;
    } catch {
      throw new Error(`file_not_at_base:${path}`);
    }
    const lines = text.split('\n');
    let start = 0;
    while (start < lines.length && context.length < MAX_EXCERPTS) {
      let end = start;
      let size = 0;
      while (end < lines.length && size + lines[end].length + 1 <= EXCERPT_CHARS) { size += lines[end].length + 1; end++; }
      if (end === start) end = start + 1;
      context.push({ path, startLine: start + 1, endLine: end });
      start = end;
    }
  }
  if (!context.length) throw new Error('no_context');
  return context;
}

export function implementationCapabilities(options: ImplementationOptions): Capability[] {
  const configured = options.repositories.filter((repository) => repository.implementation && repository.checkout);
  if (!configured.length) return [];
  const byName = new Map(configured.map((repository) => [repository.name, repository as Required<ImplementationRepository>]));
  const modelFactory = options.modelFactory ?? liveModel;
  const pipeline: Pipeline = {
    propose: proposeProject, accept: acceptProject, execute: executeProject,
    provisionNode: provisionDependencies, provisionGo: provisionGoDependencies,
    prepare: prepareProjectPublication, approve: approvePublication, publish,
    ...options.pipeline,
  };
  const common = { version: 'v1', timeoutMs: 1800000 };
  const metadata = { provider: options.provider, model: EVALUATION_MODEL, repositories: [...byName.keys()] };

  const repositoryFor = (name: string) => {
    const repository = byName.get(name);
    if (!repository) throw new Error(`no_implementation_profile:${name}`);
    return repository;
  };
  const loadProfile = async (repository: Required<ImplementationRepository>) => RepositoryProfile.parse(await readJson(repository.implementation.profile));

  const approve: Capability = {
    ...common,
    id: 'change.approve',
    interactive: true,
    description: 'Record that a person accepts a completed change proposal for implementation, and fix the files it may touch.',
    input: z.object({
      proposalJobId: z.uuid(),
      reason: Approval.shape.reason,
      /** Override the files the proposal cited. Must stay within the repository profile. */
      allowedFiles: z.array(SafePath).min(1).max(30).optional(),
      /** Proceed even when the proposal asked for more information; your note joins the request. */
      override: z.string().min(1).max(2000).optional(),
    }).strict(),
    output: ApprovalResult,
    outcome: (result) => ({ status: 'ok', label: `${result.approval.task.allowedFiles.length} file(s) approved` }),
    metadata,
    effects: ['local_artifacts'],
    execute: async ({ proposalJobId, reason, allowedFiles, override }, ctx) => {
      const parent = await ctx.dependency(proposalJobId);
      if (parent.capability !== 'change.proposal') throw new Error('dependency_not_proposal');
      const workflow = validateChangeWorkflow(ProposalResult.parse(parent.result).proposal);
      if (workflow.status !== 'completed') throw new Error('proposal_not_completed');
      const proposalRun = workflow.stages.find((stage) => stage.agent === 'change-proposal')?.run;
      const proposal = Proposal.parse(proposalRun?.result);
      if (proposal.status !== 'proposal_ready' && !override) throw new Error('proposal_not_ready');
      const repository = repositoryFor(workflow.parent.repository.name);
      const profile = await loadProfile(repository);
      const task = draftTask(workflow, proposal, profile, allowedFiles, override);
      const approval = Approval.parse({
        schemaVersion: 1, origin: 'proposal', proposalJobId, proposalHash: hash(workflow), repository: repository.name,
        baseCommit: workflow.parent.repository.commit, profileHash: hash(profile), reason, approvedAt: new Date().toISOString(), task,
      });
      return { approval };
    },
  };

  const request: Capability = {
    ...common,
    id: 'change.request',
    interactive: true,
    description: 'Describe a change in your own words for a configured repository. Produces the same approval an accepted proposal would, without an issue.',
    input: z.object({
      repository: z.enum([...byName.keys()] as [string, ...string[]]),
      title: Task.shape.title,
      request: Task.shape.request,
      /** The files the agents may edit. Must stay within the repository profile. */
      allowedFiles: z.array(SafePath).min(1).max(30),
    }).strict(),
    output: ApprovalResult,
    outcome: (result) => ({ status: 'ok', label: `${result.approval.task.allowedFiles.length} file(s) approved` }),
    metadata,
    effects: ['local_artifacts'],
    execute: async ({ repository: name, title, request: text, allowedFiles }, ctx) => {
      const repository = repositoryFor(name);
      const profile = await loadProfile(repository);
      const rejected = allowedFiles.filter((path: string) => !permittedBy(profile)(path));
      if (rejected.length) throw new Error(`files_outside_profile:${rejected.join(',')}`);
      if (allowedFiles.length > profile.changes.maximumFiles) throw new Error(`too_many_files:${profile.changes.maximumFiles}`);
      const baseCommit = await gitHead(repository.checkout, ctx.signal);
      const context = await fileContext(repository.checkout, baseCommit, allowedFiles, ctx.signal);
      const task = TaskDraft.parse({ title, request: `${text}\n\n${REQUEST_SCOPE_NOTE}`.slice(0, 40000), allowedFiles, context });
      const approval = Approval.parse({
        schemaVersion: 1, origin: 'request', repository: name, baseCommit, profileHash: hash(profile),
        reason: 'Requested directly by the operator.', approvedAt: new Date().toISOString(), task,
      });
      return { approval };
    },
  };

  const implement: Capability = {
    ...common,
    id: 'change.implement',
    lane: () => 'sandbox',
    description: 'Run the accepted pipeline for an approval: project proposal, acceptance, pinned dependencies, patch and review agents, sandbox checks.',
    input: z.object({ approvalJobId: z.uuid() }).strict(),
    output: ImplementResult,
    outcome: (result) => ({ status: result.outcome === 'candidate_verified' ? 'ok' : 'failed', label: String(result.outcome).replaceAll('_', ' ') }),
    validateOutput: (raw) => { const result = ImplementResult.parse(raw); validateProject(result.workflow); return result; },
    metadata,
    effects: ['sandbox_execution', 'model_calls', 'local_artifacts'],
    execute: async ({ approvalJobId }, ctx) => runImplementation(approvalJobId, ctx),
  };

  async function runImplementation(approvalJobId: string, ctx: CapabilityContext) {
    const parent = await ctx.dependency(approvalJobId);
    if (parent.capability !== 'change.approve' && parent.capability !== 'change.request') throw new Error('dependency_not_approval');
    const { approval } = ApprovalResult.parse(parent.result);
    const repository = repositoryFor(approval.repository);
    const profile = await loadProfile(repository);
    if (hash(profile) !== approval.profileHash) throw new Error('profile_changed_since_approval');
    const plan = verificationPlanFor(profile, approval.task);
    const task = Task.parse({
      schemaVersion: 1, id: `approval-${approvalJobId.slice(0, 8)}`, repositoryProfileHash: hash(profile), baseCommit: approval.baseCommit,
      ...approval.task, verificationHash: hash(plan), checks: plan.checks.map((check) => ({ id: check.id, baseline: 'observe' })),
    });
    const runtime = Runtime.parse(await readJson(repository.implementation.runtime));
    const dependencies: Dependency = runtime.schemaVersion === 2
      ? await pipeline.provisionGo(repository.checkout, task.baseCommit, join(ctx.directory, 'dependencies'), runtime)
      : await pipeline.provisionNode(repository.checkout, task.baseCommit, join(ctx.directory, 'dependencies'));
    const proposalDirectory = join(ctx.directory, 'project');
    const proposed = await pipeline.propose(repository.checkout, task.baseCommit, proposalDirectory, options.provider, { repositoryProfile: profile, task, modelFactory });
    if (proposed.status !== 'completed') throw new Error('project_proposal_failed');
    const proposal = Proposal.parse(proposed.proposal!.result);
    if (proposal.status !== 'proposal_ready') {
      const questions = proposal.questions.map((question) => question.question).join(' | ').slice(0, 1500);
      throw new Error(`project_proposal_needs_information: ${questions || 'no question recorded'}`);
    }
    await pipeline.accept(repository.checkout, proposalDirectory, mappingFor(proposal, profile, task), approval.reason, { runtime, dependencies, verificationPlan: plan });
    const workflow = await pipeline.execute(repository.checkout, proposalDirectory, {
      directory: join(ctx.directory, 'execution'), runtime, dependencies, provider: options.provider, modelFactory, signal: ctx.signal,
    });
    if (workflow.outcome === 'execution_failed') throw new Error(`execution_failed:${workflow.failure ?? 'unknown'}`);
    return { outcome: workflow.outcome ?? workflow.status, headCommit: workflow.headCommit, diff: workflow.diff, workflow };
  }

  const publishCapability: Capability = {
    ...common,
    id: 'change.publish',
    interactive: true,
    lane: () => 'publication',
    description: 'Open a draft pull request from a verified candidate. A person submits this; the approval is the click.',
    input: z.object({ implementJobId: z.uuid(), reason: Approval.shape.reason }).strict(),
    output: PublishResult,
    outcome: (result) => ({ status: result.status === 'published' ? 'ok' : result.status === 'unknown' ? 'partial' : 'failed', label: result.pull?.url ? `${result.status}: ${result.pull.url}` : result.status }),
    metadata,
    effects: ['github_writes', 'local_artifacts'],
    execute: async ({ implementJobId, reason }, ctx) => {
      const parent = await ctx.dependency(implementJobId);
      if (parent.capability !== 'change.implement') throw new Error('dependency_not_implementation');
      const result = ImplementResult.parse(parent.result);
      if (result.outcome !== 'candidate_verified') throw new Error(`candidate_not_verified:${result.outcome}`);
      const workflow = validateProject(result.workflow);
      const repository = repositoryFor(workflow.job.repository);
      const config = await loadPublicationConfig(repository.implementation.publication);
      const target = config.targets[repository.implementation.target];
      if (!target) throw new Error('publication_target_missing');
      const executionDirectory = join(dirname(ctx.directory), implementJobId, 'execution');
      const bundle = await pipeline.prepare(config, executionDirectory, target);
      const bundleHash = hash(bundle);
      await pipeline.approve(config, bundle.publicationId, bundleHash, { authority: 'explicit_user_session', reason });
      const state = await pipeline.publish(config, bundle.publicationId, bundleHash);
      return { publicationId: bundle.publicationId, status: state.status, pull: state.pull };
    },
  };

  return [request, approve, implement, publishCapability];
}
