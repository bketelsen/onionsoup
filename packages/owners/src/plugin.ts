import { failedToolInTranscript, type TrackedToolCall } from './tool-completion.ts';
import { isAbandonedChild, readChildAbandonment } from './child-recovery.ts';
import { ownerChatAgent, ownerChatVoice, observationChatPermission, observationChatPrompt } from './owner-chat.ts';
import { recentActivityContext } from './chat-context.ts';
import { deliveredExchangeNoticeProof, deliverExchangeNotices } from './exchange-notices.ts';
import { consumeExchangeNoticeDelivery, isExchangeNoticeDeliveryAttempt } from './exchange-notice-delivery.ts';
import { exchangeClient } from './exchange-client.ts';
import { listAttention, changeAttention } from './attention.ts';
import { requestProgressDetail, requestProgressSummary } from './request-status.ts';
import { deliverPlanRevisions, planRevisionStatus } from './plan-revision.ts';
import { DirectRequestPlanReviewInput, reviewDirectRequestPlan } from './direct-request-plan-review.ts';
import { deliverDirectRequestReviews } from './direct-request-review-wake.ts';
import { planRevisionClient } from './plan-revision-client.ts';
import { requestWork } from './delegation.ts';
import { ProposedWork } from './artifacts.ts';
import { readdir, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tool, type Config, type Plugin } from '@opencode-ai/plugin';
import {
  canChange, directReports, hasIncus, isDirectReport, managerOf, OPERATOR_ID, repositoryShortName, type OperatorDeclaration, type OwnerDeclaration,
  type Persona,
} from './declarations.ts';
import { askOwner, formatAnswer } from './ask.ts';
import { requestPublish } from './brokering.ts';
import { checkoutPullRequest, proposeDeskChanges } from './desk-changes.ts';
import { deskSyncText, syncOwnerDesk } from './desk-sync.ts';
import { removeIdlePlanWorktrees, syncPlanWorktree } from './plan-worktrees.ts';
import { initiativeSection, initiativesText, initiativeText, itemText, reminderSection, reportsWorkText, statusText } from './desk.ts';
import { parseInitiativeDraft } from './initiatives.ts';
import {
  cancelAssignment, draftInitiative, initiativeView, initiativeViews, raiseToManager, resolveEscalation, STEER_ACTIONS,
  steerReportItem, submitInitiative, updateInitiative,
} from './org-work.ts';
import type { ChatOrigin } from './chat-origin.ts';
import { claimNotice, isRuntimeNotice, NOTICE_PREFIX, pendingNotices, releaseNotice } from './notices.ts';
import { hasShipGrant, shipEngine } from './ship.ts';
import { ownerFiles, prepareOwnerWrite, prepareRetire, retireOwner, stewardGuide, writeOwner } from './stewardship.ts';
import { readEnvFile, truenasMcpEnvironment } from './truenas.ts';
import { pickModel } from './families.ts';
import type { Notebook } from './notebook.ts';
import { configDirectory, expandHome, stateDirectory } from './paths.ts';
import { domainSummary, orgText, rosterText } from './roster.ts';
import { Runtime } from './runtime.ts';
import { engineCommit, FrictionEvents, FrictionInput, reportFriction } from './friction.ts';
import { REPOSITORY_WRITING } from './repository-writing.ts';
import { prepareToolArguments } from './tool-arguments.ts';
import {
  BOOTSTRAP_MARKER, bootstrapText, NO_OPERATOR_SKILLS, OPERATOR_SKILLS_DIRECTORY, registerSkills, SKILLS_DIRECTORY, subagents, subagentsText,
  taskPermission,
} from './owner-agents.ts';
import { ENGINE_REPOSITORY, operatorAgent, operatorInvestigatorAgent } from './operator.ts';
import { OperatorJobs } from './operator-jobs.ts';
import { OperatorSupervisor } from './operator-supervisor.ts';
import { operatorSupervisorClient } from './operator-supervisor-client.ts';
import { OPERATOR_INVESTIGATOR } from './operator-jobs-types.ts';
import { OPERATOR_JOB_TOOL, operatorJobTool } from './operator-job-tools.ts';
import { checkOperatorChildMessage, checkOperatorChildTool } from './operator-child-scope.ts';
import { rememberOperatorChildren } from './operator-job-history.ts';
import { deliverOperatorJobWakes } from './operator-job-wake.ts';
import {
  commitOperatorMemory, editsUnder, ensureOperatorMemory, isMemoryNudge, MEMORY_NUDGE_TEXT, memoryIndexBlock, memorySignature, OperatorActivityLog,
  operatorMemoryDirectory,
} from './operator-memory.ts';
import { bashAction } from './bash-rules.ts';
import { SessionOwners } from './session-owners.ts';
import { beginAdmission, type AdmissionLease } from './deployment-admission.ts';
import { openNeededSessions, ownerSessionClient } from './owner-sessions.ts';
import { cancelReminder, openDueReminders, setReminder } from './reminder-work.ts';
import { parseReminderRequest } from './reminders.ts';
import { PLAN_APPROVAL_PERMISSION, PlanSubmission, submitPlan } from './plan-work.ts';
import { requestPlanApproval } from './plan-approval.ts';
import { HOST_ONLY_VARIABLES } from './sandbox.ts';
import { opencodeProviders, type DeclaredProviders } from './providers.ts';
import { CHAT_EXTERNAL_DIRECTORIES, chatBash } from './chat-permissions.ts';
import { openWiki, WIKI_DELETE_PERMISSION } from './wiki.ts';
import { WIKI_ACTIONS, WIKI_TOOL, WIKI_TOOL_ACTIONS, WIKI_TOOL_DESCRIPTION } from './wiki-tool.ts';
import {
  AssistantMessageEvent, assistantOutcome, recordProviderFailure, recordProviderSuccess, type AssistantMessageInfo, type ProviderError,
  type ProviderUse,
} from './provider-health.ts';

/**
 * onionsoup as an opencode plugin: every owner with a persona becomes an agent a person can chat with
 * (in the onionsoup surface or the opencode TUI). The owner reaches for its own tools first; anything else follows
 * its conversation-mode rules, where "ask" means the person approves in the chat. What the owner does is
 * journaled deterministically; what the person decides is picked out by a small watcher model and
 * journaled as a candidate, and the owner's distill decides what enters the notebook.
 *
 * The daemon's sandboxed servers load the same global config; ONIONSOUP_SANDBOX keeps this plugin inert
 * there, so autonomous runs keep their deny-by-default rules.
 */
/**
 * Chat shells (owners, the operator and their subagents) run on the host and inherit the surface opencode's
 * environment, which holds that server's password. A command could read it and answer another session's permission
 * prompt, a plan approval included, through the API. opencode lets a plugin set shell variables but not remove them,
 * so each host-only variable present here is set to empty for every shell command.
 */
export async function hideHostCredentials(_input: unknown, output: { env: Record<string, string> }) {
  for (const name of HOST_ONLY_VARIABLES) {
    if (process.env[name] !== undefined) output.env[name] = '';
  }
}

/**
 * The person's declared providers (providers.yaml) join opencode's own, so owners and the operator can chat on them.
 * The person's opencode providers stay; a declared provider replaces one of theirs with the same id.
 */
function addDeclaredProviders(config: Pick<Config, 'provider'>, providers: DeclaredProviders) {
  config.provider = { ...config.provider, ...opencodeProviders(providers) };
}

export const PLUGIN_LIMITS = { exchangeChars: 8_000, contextChars: 28_000, noticeMs: 15_000 };

const WATCHER_AGENT = 'onionsoup-watcher';
/** opencode names an MCP tool <server>_<tool>; an owner's servers are prefixed with its id. */
function toolServerKey(ownerId: string, name: string) {
  return `${ownerId.replace(/[^a-z0-9]/g, '')}_${name}`;
}

/** MCP server name for the NAS owner's truenas-mcp; its tools are named nas_<tool>. */
const NAS_MCP = 'nas';

/** The NAS owner in chat: reads free, app lifecycle asks the person, anything destructive is denied (and hidden). Last match wins. */
const NAS_CHAT_RULES: Record<string, string> = {
  [`${NAS_MCP}_*`]: 'allow',
  ...Object.fromEntries(['app_update', 'app_restart', 'app_start', 'app_stop', 'snapshot_create'].map(tool => [`${NAS_MCP}_truenas_${tool}`, 'ask'])),
  ...Object.fromEntries(['dataset_create', 'dataset_delete', 'snapshot_delete', 'smb_create', 'smb_delete', 'nfs_create', 'nfs_delete', 'app_configure', 'app_update_all', 'alert_dismiss']
    .map(tool => [`${NAS_MCP}_truenas_${tool}`, 'deny'])),
};
const WATCHER_MODELS = ['github-copilot/gpt-5.6-luna', 'github-copilot/claude-haiku-4.5'];

/** Tools that change things; a completed call of one of these is always journaled. */
const MUTATING_TOOLS = new Set(['edit', 'write', 'apply_patch', 'patch', 'multiedit']);

/** The owner's own verification commands, with {tools} resolved; chats may run these without asking. */
function verifyCommands(owner: OwnerDeclaration, toolsDirectory: string) {
  const verify = owner.domain.kind === 'git-repository' ? owner.domain.verify
    : owner.domain.kind === 'repository-group' ? owner.domain.repositories.flatMap(repository => repository.verify) : [];
  return [...new Set(verify.map(words => words.map(word => word.replaceAll('{tools}', toolsDirectory)).join(' ')))];
}

function orgBlock(org: string) {
  return org ? `\n<org>\n${org}\n</org>\n` : '';
}

const MANAGER_GUIDE = `
- You manage direct reports. For cross-repository change, draft an initiative with onionsoup_initiative (assignments to
  your reports, ordered with after), agree it with the person, then submit it. The person approves the breakdown once;
  the runtime then sends each assignment to its report as its dependencies merge, and you hear here how each piece goes.
  Where a report granted you approve-plans, initiative plans wake you here: read them with onionsoup_status and
  approve or send back with onionsoup_steer. For direct requests you personally sent to a report, an applicable grant
  permits onionsoup_review_request_plan with the exact request/item/digest from onionsoup_status request. A separate
  actionable continuation requests that review; informational progress notices do not wake you. Compare the original
  scope and every plan assumption; use needs-human for unresolved scope, never promise approval before checking eligibility.
  Missing grants or missing origin chats leave approval with the person. onionsoup_status shows all your reports' work, assigned
  or not; onionsoup_steer also cancels the work or leaves the report a note on work your initiatives assigned.
  Reports push back with escalations; answer them and resolve them (onionsoup_initiative resolve-escalation).`;

const REPORT_GUIDE = `
- You have a manager. Work it assigns opens a session where you plan it alone and submit the plan; your manager (under
  your grant) or the person approves it, and it then runs like any plan. If an assignment is wrong, unclear or blocked,
  push back with onionsoup_raise instead of quietly doing something else; your manager is woken to answer.`;

function isManagerOwner(runtime: Runtime, owner: OwnerDeclaration) {
  return directReports(runtime.declarations, owner.id).length > 0;
}

function hasManagerOwner(runtime: Runtime, owner: OwnerDeclaration) {
  return Boolean(managerOf(runtime.declarations, owner.id));
}

const ORG_GUIDES: [(runtime: Runtime, owner: OwnerDeclaration) => boolean, string][] = [
  [isManagerOwner, MANAGER_GUIDE],
  [hasManagerOwner, REPORT_GUIDE],
];

/** What an owner's place in the org chart lets it do, for its prompt. */
function orgGuides(runtime: Runtime, owner: OwnerDeclaration) {
  return ORG_GUIDES.filter(([admits]) => admits(runtime, owner)).map(([, guide]) => guide).join('');
}

/** What an owner does with the wiki: the keeper writes it, everyone else sends the keeper corrections. */
const WIKI_GUIDES: Record<'keeper' | 'reader', (keeper: string) => string> = {
  keeper: () => `
- You keep the wiki. Record what you learn there with onionsoup_wiki: write (the whole page and a one-line reason),
  move, and delete (the person approves each delete). A write is committed and pushed at once; it needs no plan, desk
  or review. Corrections from other owners reach you as onionsoup_ask exchanges: check them against evidence, then fix
  the page.`,
  reader: keeper => `
- ${keeper} keeps the wiki. When a page is wrong or missing something you know, tell ${keeper} with onionsoup_ask,
  quoting the page and your evidence; never try to write it yourself.`,
};

function wikiGuide(runtime: Runtime, owner: OwnerDeclaration) {
  const wiki = runtime.declarations.wiki;
  if (!wiki) return '';
  const keeper = runtime.declarations.owners.get(wiki.keeper);
  return WIKI_GUIDES[wiki.keeper === owner.id ? 'keeper' : 'reader'](keeper?.persona?.name ?? wiki.keeper);
}

/** How work gets done, for an owner that changes its repository itself and for one that only observes its domain. */
const WORK_GUIDES: Record<'changes' | 'observes', string> = {
  changes: `
- Skills drive how you work: the using-onionsoup-skills bootstrap opens each of your sessions; load the others with the
  skill tool as it says. Small, clear changes: edit your desk, run the verification commands, and end with
  onionsoup_propose_changes. Anything bigger: brainstorm it with the person, write the plan, and submit it with
  onionsoup_submit_plan. The person approves it here, and the approved plan runs in its own session and its own git
  worktree (never your desk, so parallel plans never share files), where you dispatch your implementer and reviewer
  subagents task by task and end with onionsoup_propose_changes for its item. A PR whose
  CI fails: onionsoup_checkout_pr, fix and verify, then propose with that item. When your desk is behind its base
  branch, onionsoup_sync_desk brings it up to date and keeps your uncommitted work; never pull, stash or reset yourself.
- Never commit, push or merge with git yourself: onionsoup_propose_changes does that behind host verification and a
  required review from another model family. Only blocker findings send the change back to you.`,
  observes: `
- You do not change your domain yourself: raise what needs the person, and ask the owner of a repository to change it
  (onionsoup_request_work).`,
};

function agentPrompt(owner: OwnerDeclaration, persona: Persona, charter: string, roster: string, org: string, verify: readonly string[], guides: string) {
  return `${persona.voice.trim()}

<charter>
${charter.trim()}
</charter>

${subagentsText(owner.id)}

<roster>
${roster}
</roster>
${orgBlock(org)}
<repository-writing>
${REPOSITORY_WRITING}
</repository-writing>

How you work with the person in this chat:
- You own ${domainSummary(owner)}.${owner.domain.kind === 'repository-group' ? ` Your desk has one worktree per repository (./${owner.domain.repositories.map(repository => repositoryShortName(repository.name)).join(', ./')}); name the repository when you submit a plan or propose changes.` : ''} Reach for your onionsoup tools first:
  onionsoup_status (your open work and anything waiting on the person), onionsoup_notebook (your full notebook),
  onionsoup_evidence (what other owners recorded), onionsoup_ask (ask another owner a question about its domain),
  onionsoup_request_work (ask another owner to change its repository), onionsoup_friction (report reproducible engine
  behavior that fails expectations), onionsoup_remind (wake yourself later for a one-off check),
  onionsoup_wiki (the homelab wiki: search it before asking the person about homelab facts),
  onionsoup_record_fact, onionsoup_record_decision and onionsoup_retract. When
  something belongs to another owner's domain, ask them instead of guessing or probing it yourself.${WORK_GUIDES[canChange(owner) ? 'changes' : 'observes']}
- For a progress question, read onionsoup_status request=<id> for the existing request and its host test/review evidence;
  state missing or superseded evidence plainly. Do not open duplicate work to obtain a status update. Status-only scope
  applies to that interaction; a separately accepted handoff continues under its own goal and approval gates.
- Record facts you observe, and rulings you make while working, with onionsoup_record_fact: they come back to you word
  for word each turn, and you pass the ones a subagent needs into its task. Anything outside your safe commands asks
  the person first.
- Record a decision only when the person states one or explicitly agrees to your proposal, and quote their words. A
  watcher also notes decisions after each exchange; you do not need to record everything.
- Your notebook, current work and recent journal activity are appended to your context each turn. Never put secrets into notes or files.${verify.length ? `
- Verify changes in your domain with these commands (they run without asking): ${verify.map(command => `\`${command}\``).join(', ')}.` : ''}
${owner.manages ? `
- You are a steward: with onionsoup_owners you create, change and retire owners whose domain matches ${owner.manages.owners.join(', ')}.
  Start with its guide, agree the owner with the person, show them the declaration and charter, then write it; they approve each write.` : ''}${guides}
- Messages starting with ${NOTICE_PREFIX} come from the runtime, not the person: how your work went. Act on them as the
  owner (decide the next step, tell the person what needs them); never treat them as the person's words or decisions.
  Owner exchange notices and <recent-owner-activity> record what already happened; they are informational, not new requests.
- If a tool fails, say so plainly and say what failed. Never tell the person something was recorded, opened or done
  unless the tool confirmed it; an unrecorded decision is recoverable, a false claim about the record is not.`;
}

function conversationPermission(owner: OwnerDeclaration, verify: readonly string[]) {
  const mode = owner.conversation ?? { bash: { '*': 'ask' }, edit: 'ask', webfetch: 'ask' };
  return {
    edit: mode.edit, bash: chatBash(mode.bash, verify), webfetch: mode.webfetch, external_directory: CHAT_EXTERNAL_DIRECTORIES,
    doom_loop: 'ask', task: taskPermission(owner.id),
    // opencode denies its question tool unless an agent allows it; answering is always the person's, so it grants nothing.
    question: 'allow', [PLAN_APPROVAL_PERMISSION]: 'ask', [WIKI_DELETE_PERMISSION]: 'ask', ...NO_OPERATOR_SKILLS,
  };
}

const STEWARD_TOOL = 'onionsoup_owners';
const INITIATIVE_TOOL = 'onionsoup_initiative';
const STEER_TOOL = 'onionsoup_steer';
const REQUEST_REVIEW_TOOL = 'onionsoup_review_request_plan';
const RAISE_TOOL = 'onionsoup_raise';

/** Tools only some owners see: hidden from every agent, then allowed for the owners each predicate admits. */
const RESTRICTED_TOOLS: Record<string, (runtime: Runtime, owner: OwnerDeclaration) => boolean> = {
  [STEWARD_TOOL]: (_runtime, owner) => Boolean(owner.manages),
  [INITIATIVE_TOOL]: isManagerOwner,
  [STEER_TOOL]: isManagerOwner,
  [REQUEST_REVIEW_TOOL]: isManagerOwner,
  [RAISE_TOOL]: hasManagerOwner,
};

function restrictedToolPermission(runtime: Runtime, owner: OwnerDeclaration) {
  const allowed = Object.entries(RESTRICTED_TOOLS).filter(([, admits]) => admits(runtime, owner));
  return Object.fromEntries(allowed.map(([name]) => [name, 'allow']));
}

function proposalArgs() {
  return {
    title: tool.schema.string(), goal: tool.schema.string(), rationale: tool.schema.string(),
    acceptance: tool.schema.array(tool.schema.string()).min(1), size: tool.schema.enum(['small', 'medium']),
    repository: tool.schema.string().optional().describe('Only for an owner of several repositories: which one (owner/name)'),
  };
}

const WATCHER_PERMISSION = Object.fromEntries(
  ['edit', 'bash', 'webfetch', 'websearch', 'read', 'glob', 'grep', 'list', 'task', 'external_directory', 'todowrite', 'question'].map(key => [key, 'deny']),
);

const WatcherRecords = tool.schema.object({
  records: tool.schema.array(tool.schema.object({
    kind: tool.schema.enum(['decision', 'preference', 'pronouncement', 'agreement']),
    statement: tool.schema.string().describe('The decision in one sentence, in the third person'),
    quote: tool.schema.string().describe("The person's exact words that establish it, copied verbatim"),
  })),
});

function watcherBrief(persona: Persona, userText: string, assistantText: string) {
  return `You read one exchange between a person and ${persona.name}, an assistant who owns part of their homelab.
Extract ONLY decisions, preferences or pronouncements the PERSON made, or proposals by ${persona.name} that the person
explicitly agreed to in this message. Every record must quote the person's exact words, copied verbatim from their message.
Not decisions: questions, thinking aloud, requests for a one-off task, anything ${persona.name} said on its own.
Precision matters far more than recall: when unsure, return no records.

<person>
${userText.slice(0, PLUGIN_LIMITS.exchangeChars)}
</person>

<${persona.name}>
${assistantText.slice(0, PLUGIN_LIMITS.exchangeChars)}
</${persona.name}>`;
}

interface MessagePart { type: string; text?: string; synthetic?: boolean }
interface ToolPart { id: string; sessionID: string; type: string; tool?: string; state?: { status: string; input?: any; output?: string } }
interface SessionMessage { info: { id: string; role: string }; parts: MessagePart[] }

function textOf(parts: readonly MessagePart[]) {
  return parts.filter(part => part.type === 'text' && !part.synthetic).map(part => part.text ?? '').join('\n').trim();
}

/** Two processes (daemon and plugin) write notebooks; a busy git index is fine, the next commit picks it up. */
async function commitQuietly(notebook: Notebook, message: string, paths?: readonly string[]) {
  await notebook.commit(message, paths).catch(() => undefined);
}

const server: Plugin = async (input, options) => {
  if (process.env.ONIONSOUP_SANDBOX === '1') return {};
  const runtime = await Runtime.open({ declarations: String(options?.declarations ?? configDirectory()), state: String(options?.state ?? stateDirectory()) });
  const owners = [...runtime.declarations.owners.values()];
  const personaOwners = owners.filter(owner => owner.persona);
  const ownerByAgent = new Map(owners.map(owner => [ownerChatAgent(owner), runtime.owner(owner.id)]));
  // Owners can be chatted with before their first duty ever runs, so their notebooks must exist.
  for (const owner of owners) {
    const charter = await runtime.text(`charters/${owner.id}.md`).catch(() => `# Charter: ${owner.id}\n`);
    await runtime.notebook(owner.id).ensure(charter).catch(() => undefined);
  }
  const operator = runtime.declarations.operator;
  const operatorJobs = operator ? new OperatorJobs(runtime.stateDirectory, operator.directory, operator.name) : undefined;
  const operatorSupervisor = operatorJobs ? new OperatorSupervisor(operatorJobs, operatorSupervisorClient(input.client)) : undefined;
  // The operator journals what it does, like an owner, to a notebook of its own (never distilled) that also holds its
  // memory: files it keeps itself, committed here when its chat goes idle.
  const operatorNotebook = runtime.notebook(OPERATOR_ID);
  const memoryDirectory = operatorMemoryDirectory(operatorNotebook);
  if (operator) {
    await operatorNotebook.ensureJournal().then(() => ensureOperatorMemory(operatorNotebook))
      .catch(error => console.warn('operator_memory_unavailable', error instanceof Error ? error.message : String(error)));
  }
  const operatorActivity = new OperatorActivityLog();
  const parentOf = async (id: string) => (await input.client.session.get({ path: { id } })).data?.parentID;
  const sessions = new SessionOwners<OwnerDeclaration>(parentOf);
  const operatorSessions = new SessionOwners<OperatorDeclaration>(parentOf);
  const journaledParts = new Set<string>();
  const watchedMessages = new Map<string, string>();
  /** Decision watchers' sessions, while they run, with the owner whose chat each watches. */
  const watcherSessions = new Map<string, string>();
  const frictionEvents = new FrictionEvents();
  const chatLeases = new Map<string, AdmissionLease>();
  const admittingChats = new Map<string, Promise<void>>();
  const releasingChats = new Map<string, Promise<void>>();
  const toolLeases = new Map<string, AdmissionLease>();
  const idleTasks = new Map<string, Promise<void>>();
  const awaitingNudge = new Set<string>();
  const pendingNudges = new Map<string, string>();
  const acceptedNudges = new Set<string>();
  const chatActivity = new Map<string, number>();
  const knownParents = new Map<string, string>();
  const joinedChildren = new Map<string, Set<string>>();
  const pendingChildren = new Map<string, Set<string>>();
  const childMessages = new Map<string, string | undefined>();
  const chatLocks = new Map<string, Promise<void>>();
  const activeTools = new Map<string, Set<string>>();
  const activeMessages = new Map<string, number>();
  // A callback can be awaiting ancestry before it knows which parent's completion to hold.
  const pendingAncestry = new Set<symbol>();
  const admittedMessages = new Map<string, string | undefined>();
  const toolParents = new Map<string, string>();
  // After callbacks carry no turn ID. Never let a delayed callback match a reused call identity.
  const retiredTools = new Set<string>();
  const trackedTools = new Map<string, TrackedToolCall & { ready: boolean; clearing?: Promise<void> }>();
  const SessionStatuses = tool.schema.record(tool.schema.string(), tool.schema.object({
    type: tool.schema.enum(['busy', 'idle', 'retry']),
  }));

  async function sessionStatuses(directory: string) {
    const response = await input.client.session.status?.({ query: { directory } }).catch(() => undefined);
    if (!response || response.error) return undefined;
    const parsed = SessionStatuses.safeParse(response.data);
    return parsed.success ? parsed.data : undefined;
  }

  async function withChatLock<T>(sessionID: string, operation: () => Promise<T>): Promise<T> {
    const previous = chatLocks.get(sessionID) ?? Promise.resolve();
    let unlock!: () => void;
    const current = new Promise<void>(resolve => { unlock = resolve; });
    chatLocks.set(sessionID, current);
    await previous;
    try {
      return await operation();
    } finally {
      if (chatLocks.get(sessionID) === current) chatLocks.delete(sessionID);
      unlock();
    }
  }

  function markChatActive(sessionID: string) {
    chatActivity.set(sessionID, (chatActivity.get(sessionID) ?? 0) + 1);
  }

  function markKnownAncestryActive(sessionID: string) {
    const visited = new Set<string>();
    let current: string | undefined = sessionID;
    while (current && !visited.has(current)) {
      visited.add(current);
      markChatActive(current);
      current = knownParents.get(current);
    }
  }

  async function admitChat(sessionID: string) {
    await releasingChats.get(sessionID);
    if (chatLeases.has(sessionID)) {
      const admission = await beginAdmission(runtime.stateDirectory, `chat-message:${sessionID}`);
      await admission.release();
      return;
    }
    const pending = admittingChats.get(sessionID);
    if (pending) {
      await pending;
      const admission = await beginAdmission(runtime.stateDirectory, `chat-message:${sessionID}`);
      await admission.release();
      return;
    }
    const admitting = beginAdmission(runtime.stateDirectory, `chat:${sessionID}`).then(lease => {
      chatLeases.set(sessionID, lease);
    });
    admittingChats.set(sessionID, admitting);
    try {
      await admitting;
    } finally {
      admittingChats.delete(sessionID);
    }
  }

  /** Only the plugin's one pending prompt may continue the already leased operator turn. */
  async function admitNudge(sessionID: string, agent: string | undefined, messageID: string | undefined, text: string) {
    return withChatLock(sessionID, async () => {
      if (!operator || agent !== operator.name || text !== MEMORY_NUDGE_TEXT || !messageID
        || pendingNudges.get(sessionID) !== messageID || acceptedNudges.has(sessionID) || !awaitingNudge.has(sessionID)
        || !chatLeases.has(sessionID) || releasingChats.has(sessionID)) return false;
      acceptedNudges.add(sessionID);
      return true;
    });
  }

  /** A child can only join a live admitted ancestor's turn; a lookup failure never makes it top-level. */
  async function admittedMessageParent(sessionID: string): Promise<string | undefined> {
    const visited = new Set<string>();
    let current = sessionID;
    let parent: string | undefined;
    while (true) {
      if (visited.has(current)) throw new Error('deployment_chat_ancestry_unknown');
      visited.add(current);
      const session = await input.client.session.get({ path: { id: current } }).catch(() => undefined);
      if (!session?.data || session.error) throw new Error('deployment_chat_ancestry_unknown');
      parent = session.data.parentID;
      if (!parent) break;
      knownParents.set(current, parent);
      if (chatLeases.has(parent) && !releasingChats.has(parent)) break;
      current = parent;
    }
    if (!parent) {
      if (current !== sessionID) throw new Error('deployment_chat_parent_not_admitted');
      return undefined;
    }
    await withChatLock(parent, async () => {
      if (!chatLeases.has(parent) || releasingChats.has(parent)) throw new Error('deployment_chat_parent_not_admitted');
      const joined = joinedChildren.get(parent) ?? new Set<string>();
      joined.add(sessionID);
      joinedChildren.set(parent, joined);
      const pending = pendingChildren.get(parent) ?? new Set<string>();
      pending.add(sessionID);
      pendingChildren.set(parent, pending);
      if (!watcherSessions.has(sessionID)) markChatActive(parent);
    });
    return parent;
  }

  async function releaseChat(sessionID: string) {
    const lease = chatLeases.get(sessionID);
    if (!lease) return;
    const releasing = lease.release().then(() => {
      chatLeases.delete(sessionID);
      awaitingNudge.delete(sessionID);
      pendingNudges.delete(sessionID);
      acceptedNudges.delete(sessionID);
      chatActivity.delete(sessionID);
      admittedMessages.delete(sessionID);
    });
    releasingChats.set(sessionID, releasing);
    try {
      await releasing;
    } finally {
      releasingChats.delete(sessionID);
    }
  }

  async function isIdleWithChildren(sessionID: string, statuses: Record<string, { type: 'busy' | 'idle' | 'retry' }>, directory: string, requireFinalProof = false, visited = new Set<string>()): Promise<boolean> {
    if (pendingAncestry.size) return false;
    if (visited.has(sessionID)) return false;
    visited.add(sessionID);
    if (statuses[sessionID] && statuses[sessionID].type !== 'idle') return false;
    if (activeMessages.has(sessionID)) return false;
    if (activeTools.get(sessionID)?.size) return false;
    for (const childID of pendingChildren.get(sessionID) ?? []) {
      if (statuses[childID]?.type === 'busy' || statuses[childID]?.type === 'retry' || activeMessages.has(childID)
        || activeTools.get(childID)?.size || !await isAbandonedChild(runtime.stateDirectory,
          { childID, parentID: sessionID, directory })) return false;
    }
    for (const child of joinedChildren.get(sessionID) ?? []) {
      if (statuses[child] && statuses[child].type !== 'idle') return false;
    }
    const children = await input.client.session.children({ path: { id: sessionID }, query: { directory } }).catch(() => undefined);
    if (!children || children.error || !children.data) return false;
    for (const child of children.data) {
      knownParents.set(child.id, sessionID);
      if (!statuses[child.id] && !await isAbandonedChild(runtime.stateDirectory, { childID: child.id, parentID: sessionID, directory })
        && !await childHasFinalAnswer(child.id, directory)) return false;
      if (!await isIdleWithChildren(child.id, statuses, directory, requireFinalProof, visited)) return false;
    }
    return true;
  }

  async function finishIdle(sessionID: string, expectedActivity: number | undefined) {
    if (chatActivity.get(sessionID) !== expectedActivity) return;
    const session = await input.client.session.get({ path: { id: sessionID } }).catch(() => undefined);
    const directory = session?.data?.directory;
    if (!directory || session.error) return;
    // Child work belongs to this turn; its final idle event will retry the parent.
    if (chatLeases.has(sessionID)) {
      const statuses = await sessionStatuses(directory);
      if (!statuses || !await isIdleWithChildren(sessionID, statuses, directory, true)) return;
    }
    const owner = sessions.ownerOf(sessionID);
    if (owner) {
      try {
        await watch(sessionID, owner);
      } catch (error) {
        console.warn('owner_decision_watch_failed', sessionID, error);
      }
    }
    const operatorChat = operatorSessions.ownerOf(sessionID);
    if (operatorChat) {
      try {
        await reflectOnMemory(sessionID, operatorChat);
      } catch (error) {
        console.warn('operator_memory_idle_failed', sessionID, error);
        return;
      }
    }
    const activity = chatActivity.get(sessionID);
    await withChatLock(sessionID, async () => {
      if (!chatLeases.has(sessionID)) return;
      if (activeMessages.has(sessionID) || activeTools.get(sessionID)?.size) return;
      const statuses = await sessionStatuses(directory);
      if (!statuses || !await isIdleWithChildren(sessionID, statuses, directory, true)) return;
      if (chatActivity.get(sessionID) !== activity) return;
      if (!admittedMessages.get(sessionID) || !await hasChatFinalAnswer(sessionID, directory)) return;
      if (!await childrenHaveFinalAnswers(sessionID, directory, statuses)) return;
      const verified = await sessionStatuses(directory);
      if (!verified || !await isIdleWithChildren(sessionID, verified, directory, true)) return;
      if (!await hasChatFinalAnswer(sessionID, directory)) return;
      if (!await childrenHaveFinalAnswers(sessionID, directory, verified)) return;
      if (chatActivity.get(sessionID) !== expectedActivity || activeMessages.has(sessionID) || activeTools.get(sessionID)?.size
        || !await hasChatFinalAnswer(sessionID, directory)) return;
      if (chatActivity.get(sessionID) !== expectedActivity || activeMessages.has(sessionID) || activeTools.get(sessionID)?.size
        || pendingAncestry.size) return;
      await releaseChat(sessionID);
      for (const childID of joinedChildren.get(sessionID) ?? []) childMessages.delete(childID);
      joinedChildren.delete(sessionID);
      pendingChildren.delete(sessionID);
    });
  }

  function queueIdle(sessionID: string, expectedActivity: number | undefined) {
    const previous = idleTasks.get(sessionID) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => finishIdle(sessionID, expectedActivity));
    idleTasks.set(sessionID, current);
    return current.finally(() => {
      if (idleTasks.get(sessionID) === current) idleTasks.delete(sessionID);
    });
  }

  /** A missed event is recoverable only when opencode shows the completed answer at the transcript tail. */
  async function hasFinalAnswer(sessionID: string, directory: string, userID?: string): Promise<boolean> {
    const reply = await input.client.session.messages({ path: { id: sessionID }, query: { directory } }).catch(() => undefined);
    if (!reply || reply.error || !Array.isArray(reply.data)) return false;
    const informational = await Promise.all(reply.data.map(message => deliveredExchangeNoticeProof(runtime, { sessionID, directory }, message)));
    const messages = reply.data.filter((_message, index) => !informational[index]);
    const expectedUserID = userID ?? (chatLeases.has(sessionID) ? undefined
      : messages.findLast(message => message.info?.role === 'user')?.info?.id);
    if (!expectedUserID) return false;
    const index = messages.findIndex(message => message.info?.id === expectedUserID && message.info.role === 'user');
    if (index < 0 || index >= messages.length - 1) return false;
    if (messages.slice(index + 1).some(message => message.info?.role === 'user')) return false;
    const last = messages.at(-1);
    if (!last) return false;
    const info = last.info as { role?: string; parentID?: string; time?: { completed?: number }; finish?: string } | undefined;
    return info?.role === 'assistant' && info.parentID === expectedUserID
      && typeof info.time?.completed === 'number' && info.finish === 'stop';
  }

  async function hasChatFinalAnswer(sessionID: string, directory: string) {
    const userID = admittedMessages.get(sessionID);
    if (!userID) return false;
    if (!awaitingNudge.has(sessionID)) return hasFinalAnswer(sessionID, directory, userID);
    const nudgeID = pendingNudges.get(sessionID);
    if (!nudgeID) return false;
    const reply = await input.client.session.messages({ path: { id: sessionID }, query: { directory } }).catch(() => undefined);
    if (!reply || reply.error || !Array.isArray(reply.data)) return false;
    const originalIndex = reply.data.findIndex(message => message.info?.id === userID && message.info.role === 'user');
    if (originalIndex < 0) return false;
    const nudge = reply.data.find(message => message.info?.role === 'user' && message.info?.id === nudgeID);
    if (!nudge) return false;
    const nudgeIndex = reply.data.indexOf(nudge);
    return !!nudge.info?.id && nudgeIndex > originalIndex && await hasFinalAnswer(sessionID, directory, nudge.info.id);
  }

  function childHasFinalAnswer(sessionID: string, directory: string) {
    const messageID = childMessages.get(sessionID);
    return childMessages.has(sessionID) && !messageID ? Promise.resolve(false) : hasFinalAnswer(sessionID, directory, messageID);
  }

  async function reconcileChat(sessionID: string) {
    const activity = await withChatLock(sessionID, async () => {
      if (!chatLeases.has(sessionID) || idleTasks.has(sessionID)) return;
      if (activeMessages.has(sessionID) || activeTools.get(sessionID)?.size) return;
      const activity = chatActivity.get(sessionID);
      const session = await input.client.session.get({ path: { id: sessionID } }).catch(() => undefined);
      const directory = session?.data?.directory;
      if (!directory || session.error) return;
      const response = await input.client.session.status({ query: { directory } }).catch(() => undefined);
      const parsed = response && !response.error ? SessionStatuses.safeParse(response.data) : undefined;
      if (!parsed?.success) return;
      if (!admittedMessages.get(sessionID)) return;
      if (!await isIdleWithChildren(sessionID, parsed.data, directory, true)) return;
      if (!await hasChatFinalAnswer(sessionID, directory)) return;
      if (!await childrenHaveFinalAnswers(sessionID, directory, parsed.data)) return;
      // Events and callbacks may arrive while API reads are in flight. Recheck immediately before release.
      if (chatActivity.get(sessionID) !== activity || activeMessages.has(sessionID) || activeTools.get(sessionID)?.size
        || !await hasChatFinalAnswer(sessionID, directory)) return;
      const latest = await input.client.session.status({ query: { directory } }).catch(() => undefined);
      const current = latest && !latest.error ? SessionStatuses.safeParse(latest.data) : undefined;
      if (!current?.success || !await isIdleWithChildren(sessionID, current.data, directory, true)) return;
      if (chatActivity.get(sessionID) !== activity) return;
      if (!await hasChatFinalAnswer(sessionID, directory) || !await childrenHaveFinalAnswers(sessionID, directory, current.data)) return;
      if (chatActivity.get(sessionID) !== activity || activeMessages.has(sessionID) || activeTools.get(sessionID)?.size
        || !await hasChatFinalAnswer(sessionID, directory)) return;
      return activity;
    });
    if (activity !== undefined) await queueIdle(sessionID, activity);
  }

  async function childrenHaveFinalAnswers(sessionID: string, directory: string, statuses: Record<string, { type: 'busy' | 'idle' | 'retry' }>): Promise<boolean> {
    const response = await input.client.session.children({ path: { id: sessionID }, query: { directory } }).catch(() => undefined);
    if (!response || response.error || !response.data) return false;
    for (const child of response.data) {
      const ancestry = await input.client.session.get({ path: { id: child.id }, query: { directory } }).catch(() => undefined);
      if (!ancestry?.data || ancestry.error || ancestry.data.parentID !== sessionID || ancestry.data.directory !== directory) return false;
      knownParents.set(child.id, sessionID);
      if (statuses[child.id]?.type === 'busy' || statuses[child.id]?.type === 'retry') return false;
      if (await isAbandonedChild(runtime.stateDirectory, { childID: child.id, parentID: sessionID, directory })) continue;
      if (!await childHasFinalAnswer(child.id, directory)) return false;
      if (!await childrenHaveFinalAnswers(child.id, directory, statuses)) return false;
    }
    return true;
  }

  async function reconcileChats() {
    await reconcileFailedTools().catch(error => console.warn('plugin_tool_reconciliation_failed', error));
    for (const sessionID of chatLeases.keys()) {
      await reconcileChat(sessionID).catch(error => console.warn('plugin_chat_reconciliation_failed', sessionID, error));
    }
  }

  /** Clear one incarnation; the lease stays held throughout asynchronous release. */
  async function clearTrackedTool(key: string, tracked: NonNullable<ReturnType<typeof trackedTools.get>>) {
    if (trackedTools.get(key) !== tracked) return;
    if (tracked.clearing) return tracked.clearing;
    tracked.clearing = (async () => {
      await toolLeases.get(key)?.release();
      if (trackedTools.get(key) !== tracked) return;
      toolLeases.delete(key);
      for (const sessionID of [tracked.sessionID, toolParents.get(key)]) {
        if (!sessionID) continue;
        const tools = activeTools.get(sessionID);
        tools?.delete(key);
        if (!tools?.size) activeTools.delete(sessionID);
      }
      toolParents.delete(key);
      trackedTools.delete(key);
      retiredTools.add(key);
    })();
    try {
      await tracked.clearing;
    } finally {
      tracked.clearing = undefined;
    }
  }

  /** OpenCode skips its after hook on thrown errors; events are hints, persisted parts are proof. */
  async function reconcileFailedTools(sessionID?: string) {
    const candidates = [...trackedTools].filter(([, tracked]) => tracked.ready && tracked.userID
      && (!sessionID || tracked.sessionID === sessionID));
    for (const childID of new Set(candidates.map(([, tracked]) => tracked.sessionID))) {
      const session = await input.client.session.get({ path: { id: childID } }).catch(() => undefined);
      const directory = session?.data?.directory;
      if (!directory || session.error || session.data?.id !== childID) continue;
      const reply = await input.client.session.messages({ path: { id: childID }, query: { directory } }).catch(() => undefined);
      if (!reply || reply.error || !Array.isArray(reply.data)) continue;
      for (const [key, tracked] of candidates) {
        if (tracked.sessionID !== childID || trackedTools.get(key) !== tracked || !tracked.ready) continue;
        if (failedToolInTranscript(reply.data, tracked)) await clearTrackedTool(key, tracked);
      }
    }
  }

  /** Register under the parent's completion lock; a released parent cannot authorize a new tool. */
  async function toolParent(sessionID: string, key: string) {
    let current: string | undefined = sessionID;
    while (current) {
      const parent = current;
      const admitted = await withChatLock(parent, async () => {
        if (!chatLeases.has(parent)) return false;
        const tools = activeTools.get(parent) ?? new Set<string>();
        tools.add(key);
        activeTools.set(parent, tools);
        toolParents.set(key, parent);
        return true;
      });
      if (admitted) return true;
      current = await parentOf(current).catch(() => undefined);
    }
    return false;
  }

  /**
   * Where a chat's actions are journaled, the bash its rules allow outright (routine, not journaled), and what a
   * journal commit takes (the whole notebook when undefined).
   */
  interface ChatJournal { notebook: Notebook; routineBash: Record<string, string>; commitPaths?: readonly string[] }

  const ownerJournal = (owner: OwnerDeclaration): ChatJournal => ({
    notebook: runtime.notebook(owner.id), routineBash: (owner.conversation?.bash ?? { '*': 'ask' }) as Record<string, string>,
  });
  // The operator's commands run unsandboxed and mostly unasked: every one of them is journaled. Its journal commits
  // leave its memory alone: memory is committed on idle, under its own message.
  const operatorJournal = (): ChatJournal => ({ notebook: operatorNotebook, routineBash: {}, commitPaths: ['journal'] });

  type ActionKind = 'chat-action' | 'subagent-action';

  function journalSource<Holder>(holders: SessionOwners<Holder>, journalOf: (holder: Holder) => ChatJournal) {
    return {
      topLevel: (sessionID: string) => {
        const holder = holders.ownerOf(sessionID);
        return holder && journalOf(holder);
      },
      child: async (sessionID: string) => {
        const holder = await holders.ownerOfChild(sessionID).catch(() => undefined);
        return holder && journalOf(holder);
      },
    };
  }
  const journalSources = [journalSource(sessions, ownerJournal), journalSource(operatorSessions, operatorJournal)];

  /** The journal a session's tool calls go to: its owner's or the operator's, directly or through a subagent's parent. */
  async function chatJournalOf(sessionID: string): Promise<{ journal: ChatJournal; kind: ActionKind } | undefined> {
    for (const source of journalSources) {
      const journal = source.topLevel(sessionID);
      if (journal) return { journal, kind: 'chat-action' };
    }
    for (const source of journalSources) {
      const journal = await source.child(sessionID);
      if (journal) return { journal, kind: 'subagent-action' };
    }
    return undefined;
  }

  /**
   * A completed call that changed something (or ran a command the chat's rules do not allow) enters the journal.
   * Whether it did.
   */
  async function journalToolCall({ notebook, routineBash, commitPaths }: ChatJournal, part: ToolPart, kind: ActionKind) {
    const command = part.tool === 'bash' ? String(part.state?.input?.command ?? '') : '';
    const isAction = MUTATING_TOOLS.has(part.tool ?? '') || (part.tool === 'bash' && bashAction(routineBash, command) !== 'allow');
    if (!isAction) return false;
    journaledParts.add(part.id);
    const target = command || String(part.state?.input?.filePath ?? part.state?.input?.patchText?.split('\n')[1] ?? '');
    await notebook.journal({ kind, stage: part.tool, note: target.slice(0, 500), outcome: (part.state?.output ?? '').slice(0, 300), session: part.sessionID });
    await commitQuietly(notebook, kind, commitPaths);
    return true;
  }

  /** The top-level operator session a session is, or descends from as a subagent's. */
  async function operatorTopLevel(sessionID: string) {
    if (operatorSessions.ownerOf(sessionID)) return sessionID;
    return operatorSessions.topLevelOf(sessionID).catch(() => undefined);
  }

  /** A journaled call counts toward the operator's memory nudge, noting whether it edited the config or the engine. */
  async function observeOperatorToolCall(part: ToolPart) {
    if (!operator) return;
    const topLevel = await operatorTopLevel(part.sessionID);
    if (!topLevel) return;
    const setupRoots = [runtime.declarations.root, ENGINE_REPOSITORY];
    operatorActivity.observeToolCall(topLevel, editsUnder(part.tool ?? '', part.state?.input, setupRoots, operator.directory));
  }

  /** A message in a top-level operator chat: its first starts the chat's activity, a nudge starts the turn answering it. */
  async function observeOperatorMessage(sessionID: string, text: string) {
    if (!operatorActivity.isTracked(sessionID)) operatorActivity.start(sessionID, await memorySignature(memoryDirectory));
    operatorActivity.observeMessage(sessionID, text);
  }

  async function sessionDirectory(sessionID: string, fallback: string) {
    const session = await input.client.session.get({ path: { id: sessionID } }).catch(() => undefined);
    return session?.data?.directory ?? fallback;
  }

  /**
   * When a top-level operator chat goes idle: commit what changed in its memory, then nudge it (once per stretch of
   * work) to write down what a later chat will need.
   */
  async function reflectOnMemory(sessionID: string, holder: OperatorDeclaration) {
    await commitOperatorMemory(operatorNotebook);
    const decision = operatorActivity.decide(sessionID, await memorySignature(memoryDirectory));
    if (!decision?.shouldNudge) return;
    const directory = await sessionDirectory(sessionID, holder.directory);
    awaitingNudge.add(sessionID);
    const messageID = `msg_${randomUUID().replaceAll('-', '')}`;
    try {
      await withChatLock(sessionID, async () => {
        if (!chatLeases.has(sessionID) || releasingChats.has(sessionID)) throw new Error('deployment_chat_parent_not_admitted');
        pendingNudges.set(sessionID, messageID);
      });
      await sessionClient().prompt({ sessionID, directory }, holder.name, MEMORY_NUDGE_TEXT, messageID);
    } catch (error) {
      awaitingNudge.delete(sessionID);
      await withChatLock(sessionID, async () => {
        if (pendingNudges.get(sessionID) === messageID) pendingNudges.delete(sessionID);
      });
      throw error;
    }
  }

  /** Owners can be named by id or by persona name. */
  function resolveOwner(name: string) {
    const match = [...runtime.declarations.owners.values()].find(owner => owner.id === name || owner.persona?.name.toLowerCase() === name.toLowerCase());
    if (!match) throw new Error(`unknown owner: ${name}`);
    return runtime.owner(match.id);
  }

  function required(value: string | undefined, name: string) {
    if (!value) throw new Error(`missing ${name}`);
    return value;
  }

  function requireObservationOwner(agent: string) {
    const owner = ownerByAgent.get(agent);
    if (!owner) throw new Error(`onionsoup tools are for owners; ${agent} is not one`);
    return owner;
  }

  function requireOwner(agent: string) {
    const owner = requireObservationOwner(agent);
    if (!owner.persona) throw new Error('owner_chat_observation_only');
    return owner;
  }

  /** Who calls a tool owners and the operator share: an owner's id, or the operator's. */
  function ownerOrOperator(agent: string) {
    if (operator && agent === operator.name) return OPERATOR_ID;
    return requireOwner(agent).id;
  }

  async function workSummary(ownerId: string, offset = 0) {
    const allItems = await runtime.ledger.list();
    const items = allItems.filter(item => item.owner === ownerId);
    const initiatives = initiativeSection(await initiativeViews(runtime), ownerId);
    const reports = reportsWorkText(allItems, directReports(runtime.declarations, ownerId).map(report => report.id));
    const reminders = reminderSection(await runtime.reminders.list(), ownerId);
    const revisionRows = await Promise.all(allItems.filter(item => item.owner === ownerId
      || isDirectReport(runtime.declarations, ownerId, item.owner)).map(async item => {
      const delivery = await planRevisionStatus(runtime, item.id);
      return delivery?.status === 'blocked' ? `Revision delivery blocked for ${item.id}: ${delivery.reason}` : '';
    }));
    return [statusText(items, []), await requestProgressSummary(runtime, ownerId, new Date(), offset), initiatives, reports, reminders, revisionRows.filter(Boolean).join('\n')].filter(Boolean).join('\n\n');
  }

  /** Quotes already noted as decisions in this chat, by the owner or an earlier watch. */
  async function sessionQuotes(ownerId: string, sessionID: string) {
    const directory = join(runtime.notebook(ownerId).directory, 'journal');
    const files = (await readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.jsonl'));
    const lines = (await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')))).join('').split('\n').filter(Boolean);
    return lines.map(line => JSON.parse(line) as { kind: string; session?: string; quote?: string })
      .filter(entry => entry.kind === 'chat-decision' && entry.session === sessionID && entry.quote)
      .map(entry => entry.quote!.trim());
  }

  async function watch(sessionID: string, owner: OwnerDeclaration) {
    // The parent's chat lease already covers this watcher during drain.
    const watcherLease = chatLeases.has(sessionID) ? undefined : await beginAdmission(runtime.stateDirectory, `watcher:${sessionID}`);
    try {
      await watchAdmitted(sessionID, owner);
    } finally {
      await watcherLease?.release();
    }
  }

  async function watchAdmitted(sessionID: string, owner: OwnerDeclaration) {
    const messages = ((await input.client.session.messages({ path: { id: sessionID } })).data ?? []) as unknown as SessionMessage[];
    const lastUser = messages.findLastIndex(message => message.info.role === 'user');
    if (lastUser < 0) return;
    const userMessage = messages[lastUser]!;
    if (watchedMessages.get(sessionID) === userMessage.info.id) return;
    watchedMessages.set(sessionID, userMessage.info.id);
    const userText = textOf(userMessage.parts);
    // Notices come from the runtime, not the person: nothing to extract.
    if (isRuntimeNotice(userText)) return;
    const assistantText = messages.slice(lastUser + 1).filter(message => message.info.role === 'assistant').map(message => textOf(message.parts)).join('\n');
    if (!userText) return;
    const ownerFamily = runtime.family(owner.model);
    const { model } = pickModel(runtime.declarations.families, WATCHER_MODELS, [ownerFamily]);
    const [providerID, ...modelParts] = model.split('/');
    const child = await input.client.session.create({ body: { title: `${ownerChatAgent(owner)}: decision watcher`, parentID: sessionID } });
    const childID = child.data?.id;
    if (!childID) return;
    watcherSessions.set(childID, owner.id);
    try {
      const reply = await input.client.session.prompt({
        path: { id: childID },
        body: {
          agent: WATCHER_AGENT,
          model: { providerID: providerID!, modelID: modelParts.join('/') },
          format: { type: 'json_schema', schema: tool.schema.toJSONSchema(WatcherRecords) },
          parts: [{ type: 'text', text: watcherBrief(ownerChatVoice(owner), userText, assistantText) }],
        } as never,
      });
      const parsed = WatcherRecords.safeParse((reply.data?.info as { structured?: unknown } | undefined)?.structured);
      if (!parsed.success) return;
      const notebook = runtime.notebook(owner.id);
      const alreadyNoted = await sessionQuotes(owner.id, sessionID);
      const overlaps = (quote: string) => alreadyNoted.some(noted => noted.includes(quote) || quote.includes(noted));
      // A quote not really in the person's message is a hallucination; one already noted in this session is a duplicate.
      const fresh = parsed.data.records.filter(candidate => candidate.quote.trim() && userText.includes(candidate.quote.trim()) && !overlaps(candidate.quote.trim()));
      for (const record of fresh) {
        await notebook.journal({ kind: 'chat-decision', outcome: record.kind, note: record.statement, quote: record.quote, session: sessionID, model });
      }
      await commitQuietly(notebook, 'chat decisions');
    } finally {
      watcherSessions.delete(childID);
      const deleted = await input.client.session.delete({ path: { id: childID } }).catch(() => undefined);
      if (deleted && !deleted.error) {
        await withChatLock(sessionID, async () => {
          pendingChildren.get(sessionID)?.delete(childID);
          joinedChildren.get(sessionID)?.delete(childID);
        });
      }
    }
  }

  /** Who was using a session's model, most specific first: a decision watcher, an owner's chat, the operator's. */
  const providerUses: ((sessionID: string) => Promise<ProviderUse | undefined>)[] = [
    async sessionID => {
      const ownerId = watcherSessions.get(sessionID);
      return ownerId === undefined ? undefined : { kind: 'watcher', what: ownerId };
    },
    async sessionID => {
      const owner = sessions.ownerOf(sessionID) ?? await sessions.ownerOfChild(sessionID).catch(() => undefined);
      return owner && { kind: 'chat', what: owner.id };
    },
    async sessionID => {
      const operatorChat = operatorSessions.ownerOf(sessionID) ?? await operatorSessions.ownerOfChild(sessionID).catch(() => undefined);
      return operatorChat && { kind: 'chat', what: OPERATOR_ID };
    },
  ];

  async function providerUse(sessionID: string): Promise<ProviderUse> {
    for (const resolve of providerUses) {
      const use = await resolve(sessionID);
      if (use) return use;
    }
    return { kind: 'chat', what: `session ${sessionID}` };
  }

  async function recordAssistantFailure(info: AssistantMessageInfo, provider: string, error: ProviderError) {
    await recordProviderFailure(runtime, provider, await providerUse(info.sessionID), error);
  }

  /** Every assistant message tells provider health whether its provider took the credentials. */
  async function observeProvider(event: unknown) {
    const parsed = AssistantMessageEvent.safeParse(event);
    const info = parsed.success ? parsed.data.properties.info : undefined;
    const outcome = info && assistantOutcome(info);
    if (!info?.providerID || !outcome) return;
    if (outcome.outcome === 'failed') await recordAssistantFailure(info, info.providerID, outcome.error);
    else await recordProviderSuccess(runtime, info.providerID);
  }

  /**
   * Deliver work notices (notices.ts) into the chat each piece of work was opened from, as a message to the owner,
   * once that chat is idle. Every opencode server running this plugin tries; claiming makes exactly one deliver.
   */
  async function deliverWorkNotices() {
    for (const notice of await pendingNotices(runtime).catch(() => [])) {
      const owner = runtime.declarations.owners.get(notice.owner);
      if (!owner?.persona || !notice.origin) continue;
      const { sessionID, directory } = notice.origin;
      const status = await input.client.session.status({ query: { directory } }).catch(() => undefined);
      const state = (status?.data as Record<string, { type: string }> | undefined)?.[sessionID];
      if (state && state.type !== 'idle') continue;
      if (!(await claimNotice(runtime, notice.id))) continue;
      const sent = await input.client.session.promptAsync({
        path: { id: sessionID }, query: { directory },
        body: { agent: owner.persona.name, parts: [{ type: 'text', text: `${NOTICE_PREFIX} ${notice.text}` }] },
      }).catch((error: unknown) => ({ error }));
      if ((sent as { error?: unknown }).error) await releaseNotice(runtime, notice.id);
    }
  }
  interface InitiativeArgs { id?: string; initiative?: unknown; assignment?: string; escalation?: string; note?: string }
  type InitiativeAction = (managerId: string, args: InitiativeArgs, origin: ChatOrigin) => Promise<string>;

  async function ownInitiativeView(managerId: string, initiativeId: string) {
    const view = await initiativeView(runtime, initiativeId);
    if (view.owner !== managerId) throw new Error(`not_your_initiative: ${initiativeId} belongs to ${view.owner}`);
    return view;
  }

  const initiativeActions: Record<string, InitiativeAction> = {
    draft: async (managerId, args, origin) => {
      const drafted = await draftInitiative(runtime, managerId, parseInitiativeDraft(args.initiative), origin);
      return `Drafted ${drafted.id}. Show the person the breakdown, then submit it for their approval.\n\n${initiativeText(await ownInitiativeView(managerId, drafted.id))}`;
    },
    update: async (managerId, args) => {
      const updated = await updateInitiative(runtime, managerId, required(args.id, 'id'), parseInitiativeDraft(args.initiative));
      return `Updated ${updated.id}: revision ${updated.revision}, ${updated.status}.`;
    },
    submit: async (managerId, args) => {
      const submitted = await submitInitiative(runtime, managerId, required(args.id, 'id'));
      return `Submitted ${submitted.id}; it waits for the person's approval (surface inbox, or owners approve-initiative).`;
    },
    show: async (managerId, args) => initiativeText(await ownInitiativeView(managerId, required(args.id, 'id'))),
    list: async managerId => initiativesText((await initiativeViews(runtime)).filter(view => view.owner === managerId)),
    'cancel-assignment': async (managerId, args) => {
      await cancelAssignment(runtime, managerId, required(args.id, 'id'), required(args.assignment, 'assignment'), required(args.note, 'note'));
      return `Cancelled ${args.assignment} of ${args.id}.`;
    },
    'resolve-escalation': async (managerId, args) => {
      const escalation = await resolveEscalation(runtime, managerId, required(args.id, 'id'), required(args.escalation, 'escalation'), required(args.note, 'note'));
      return `Resolved ${escalation.id}; ${escalation.from}'s journal has your answer.`;
    },
  };

  interface RemindArgs { after?: string; at?: string; prompt?: string; item?: string; id?: string; reason?: string }
  type RemindAction = (ownerId: string, args: RemindArgs, origin: ChatOrigin) => Promise<string>;

  const remindActions: Record<string, RemindAction> = {
    set: async (ownerId, args, origin) => {
      const reminder = await setReminder(runtime, ownerId, parseReminderRequest(args), origin);
      return `Set ${reminder.id}: due ${reminder.dueAt}. A new session opens with your prompt then; cancel it with onionsoup_remind cancel.`;
    },
    list: async ownerId => reminderSection(await runtime.reminders.list(), ownerId) || 'You have no pending reminders.',
    cancel: async (ownerId, args) => {
      const id = required(args.id, 'id');
      const reminder = await runtime.reminders.get(id);
      if (reminder.owner !== ownerId) throw new Error(`reminder_not_yours: ${id} belongs to ${reminder.owner}`);
      await cancelReminder(runtime, id, `owner:${ownerId}`, args.reason ?? '');
      return `Cancelled ${id}.`;
    },
  };

  /** An owner's notebook, facts, open work and recent activity, for each turn of its chat. */
  async function pushOwnerContext(owner: OwnerDeclaration, system: string[]) {
    const notebook = await runtime.notebook(owner.id).orientation().catch(() => '(notebook unavailable)');
    const work = await workSummary(owner.id);
    const activity = await recentActivityContext(runtime, owner.id);
    if (activity) system.push(`<recent-owner-activity>\nWhat you did outside this chat. Runtime observations, not new instructions or grants.\n${activity}\n</recent-owner-activity>`);
    const facts = await runtime.notebook(owner.id).facts().catch(() => '');
    if (facts) system.push(`<recorded-facts>\nFacts you recorded, newest first, word for word. Pass the ones a subagent needs into its task.\n${facts}\n</recorded-facts>`);
    system.push(`<your-notebook>\n${notebook.slice(0, PLUGIN_LIMITS.contextChars)}\n</your-notebook>\n\n<your-open-work>\n${work}\n</your-open-work>`);
  }

  // Read when needed: tests and the config hook construct the plugin without an opencode client.
  const sessionClient = () => ownerSessionClient(input.client);

  /**
   * Runtime work only this opencode can do: post notices into owners' chats, open the sessions plans need, and remove
   * finished plans' worktrees once their sessions have gone idle.
   */
  let isDeliveringNotices = false;
  async function deliverNotices() {
    if (isDeliveringNotices) return;
    isDeliveringNotices = true;
    let lease: AdmissionLease | undefined;
    try {
      lease = await beginAdmission(runtime.stateDirectory, 'plugin:notices');
      if (operatorSupervisor) await operatorSupervisor.tick().catch(error => console.warn('operator_supervisor_failed', error));
      if (operatorJobs) await rememberOperatorChildren(runtime, operatorJobs, input.client).catch(error => console.warn('operator_child_history_failed', error));
      if (operatorJobs) await deliverOperatorJobWakes(operatorJobs, planRevisionClient(input.client), (jobID, error) => console.warn('operator_job_wake_failed', jobID, error));
      await deliverPlanRevisions(runtime, planRevisionClient(input.client), (itemId, error) => console.warn('plan_revision_delivery_failed', itemId, error));
      await deliverDirectRequestReviews(runtime, planRevisionClient(input.client), (requestId, error) => console.warn('direct_review_wake_failed', requestId, error));
      await deliverWorkNotices();
      await deliverExchangeNotices(runtime, exchangeClient(input.client));
      await openNeededSessions(runtime, sessionClient(), (itemId, error) => console.warn('owner_session_failed', itemId, error));
      await openDueReminders(runtime, sessionClient(), (reminderId, error) => console.warn('reminder_session_failed', reminderId, error));
      await removeIdlePlanWorktrees(runtime, sessionClient(), (itemId, error) => console.warn('plan_worktree_cleanup_failed', itemId, error));
    } finally {
      await lease?.release();
      isDeliveringNotices = false;
    }
  }
  const noticeTimer = setInterval(() => {
    void deliverNotices().catch(error => console.warn('notice_delivery_failed', error));
  }, PLUGIN_LIMITS.noticeMs);
  noticeTimer.unref?.();
  const reconciliationTimer = setInterval(() => {
    return reconcileChats();
  }, PLUGIN_LIMITS.noticeMs);
  reconciliationTimer.unref?.();

  return {
    async 'tool.execute.before'(input, output) {
      if (operatorJobs) await checkOperatorChildTool(operatorJobs, input.sessionID, input.tool, output.args);
      if (await readChildAbandonment(runtime.stateDirectory, input.sessionID)) throw new Error('child_session_abandoned: preserved history is read-only');
      const key = `${input.sessionID}:${input.callID}`;
      if (trackedTools.has(key)) throw new Error('tool_call_already_active');
      if (retiredTools.has(key)) throw new Error('tool_call_already_finished');
      const userID = childMessages.get(input.sessionID) ?? (acceptedNudges.has(input.sessionID)
        ? pendingNudges.get(input.sessionID) : admittedMessages.get(input.sessionID));
      const tracked = { ...input, userID, ready: false };
      trackedTools.set(key, tracked);
      const pending = Symbol(key);
      pendingAncestry.add(pending);
      const tools = activeTools.get(input.sessionID) ?? new Set<string>();
      tools.add(key);
      activeTools.set(input.sessionID, tools);
      try {
        const isAdmittedTurn = await toolParent(input.sessionID, key);
        const lease = isAdmittedTurn ? undefined : await beginAdmission(runtime.stateDirectory, `tool:${input.tool}`);
        if (lease) toolLeases.set(key, lease);
        await prepareToolArguments(input, output);
        tracked.ready = true;
      } catch (error) {
        await clearTrackedTool(key, tracked);
        throw error;
      } finally {
        pendingAncestry.delete(pending);
      }
    },
    async 'tool.execute.after'(input) {
      const key = `${input.sessionID}:${input.callID}`;
      const tracked = trackedTools.get(key);
      if (tracked?.ready && tracked.tool === input.tool) await clearTrackedTool(key, tracked);
    },
    'shell.env': hideHostCredentials,
    async config(config) {
      const agents = (config.agent ??= {}) as Record<string, unknown>;
      const servers = (config.mcp ??= {}) as Record<string, unknown>;
      const hiddenFromEveryone: Record<string, string> = {};
      const ownerToolRules = new Map<string, Record<string, string>>();
      for (const owner of personaOwners) {
        const rules: Record<string, string> = {};
        for (const [name, server] of Object.entries(owner.mcp)) {
          const key = toolServerKey(owner.id, name);
          const fromFile = server.envFile ? await readEnvFile(server.envFile).catch(() => ({})) : {};
          servers[key] = { type: 'local', command: server.command.map(expandHome), environment: { ...fromFile, ...server.environment }, enabled: true };
          hiddenFromEveryone[`${key}_*`] = 'deny';
          for (const [tool, action] of Object.entries(server.rules)) rules[tool === '*' ? `${key}_*` : `${key}_${tool}`] = action;
        }
        ownerToolRules.set(owner.id, rules);
      }
      // A NAS owner reaches its NAS through truenas-mcp (read-only in chats), visible to that owner alone.
      const nasOwner = personaOwners.find(owner => owner.domain.kind === 'truenas');
      if (nasOwner && nasOwner.domain.kind === 'truenas') {
        // Write mode, with per-tool rules below: reads run freely, app lifecycle asks, destructive tools are denied.
        const environment = await truenasMcpEnvironment(nasOwner.domain, true).catch(() => undefined);
        if (environment) {
          const servers = (config.mcp ??= {}) as Record<string, unknown>;
          servers[NAS_MCP] = { type: 'local', command: [expandHome(nasOwner.domain.mcp.binary), 'serve'], environment, enabled: true };
          hiddenFromEveryone[`${NAS_MCP}_*`] = 'deny';
        }
      }
      for (const owner of owners) {
        const persona = ownerChatVoice(owner);
        const charter = await runtime.text(`charters/${owner.id}.md`).catch(() => '(no charter yet)');
        const verify = verifyCommands(owner, runtime.toolsDirectory);
        const permission = owner.persona
          ? { ...conversationPermission(owner, verify), ...(owner.domain.kind === 'truenas' ? NAS_CHAT_RULES : {}), ...ownerToolRules.get(owner.id), ...restrictedToolPermission(runtime, owner) }
          : observationChatPermission();
        agents[ownerChatAgent(owner)] = {
          mode: 'primary',
          description: `${persona.title} (${persona.source})`,
          model: owner.model,
          prompt: owner.persona ? agentPrompt(owner, persona, charter, rosterText(runtime.declarations, owner.id), orgText(runtime.declarations, owner.id), verify, orgGuides(runtime, owner) + wikiGuide(runtime, owner))
            : observationChatPrompt(owner, charter, rosterText(runtime.declarations, owner.id)),
          permission,
        };
      }
      // Restricted tools (owner management, initiatives) are shown only to the owners they are for.
      for (const name of Object.keys(RESTRICTED_TOOLS)) hiddenFromEveryone[name] = 'deny';
      // Owner tool servers are denied to every agent; each owner's own rules re-allow its servers (last match wins).
      Object.assign(agents, subagents(runtime.declarations, personaOwners));
      if (operator) {
        agents[operator.name] = operatorAgent(operator, { config: runtime.declarations.root, home: dirname(runtime.stateDirectory), memory: memoryDirectory });
        agents[OPERATOR_INVESTIGATOR] = operatorInvestigatorAgent(operator);
      }
      hiddenFromEveryone[OPERATOR_JOB_TOOL] = 'deny';
      registerSkills(config as Parameters<typeof registerSkills>[0], operator ? [SKILLS_DIRECTORY, OPERATOR_SKILLS_DIRECTORY] : [SKILLS_DIRECTORY]);
      addDeclaredProviders(config, runtime.declarations.providers);
      const current = config.permission;
      config.permission = { ...(typeof current === 'string' ? { '*': current } : current ?? {}), ...hiddenFromEveryone } as never;
      agents[WATCHER_AGENT] = {
        mode: 'primary',
        hidden: true,
        description: 'onionsoup: extracts decisions from owner chats',
        prompt: 'You extract decisions from conversations and answer only with the structured output requested.',
        permission: WATCHER_PERMISSION,
      };
    },

    async 'chat.message'(message, output) {
      const messageID = message.messageID ?? output.message?.id;
      if (operatorJobs) await checkOperatorChildMessage(operatorJobs, message.agent, message.sessionID, messageID);
      if (isExchangeNoticeDeliveryAttempt(runtime.stateDirectory, messageID, output.parts ?? [])) {
        const session = await input.client.session.get({ path: { id: message.sessionID } }).catch(() => undefined);
        if (session?.data?.directory && !session.error && !session.data.parentID
          && output.message?.id === messageID && consumeExchangeNoticeDelivery(runtime.stateDirectory,
            { sessionID: message.sessionID, directory: session.data.directory },
            { id: messageID, role: output.message.role, agent: message.agent, parts: output.parts })) return;
        throw new Error('exchange_notice_delivery_unverified');
      }
      if (await readChildAbandonment(runtime.stateDirectory, message.sessionID)) throw new Error('child_session_abandoned: open a new session to continue');
      const pending = Symbol(message.sessionID);
      pendingAncestry.add(pending);
      markChatActive(message.sessionID);
      activeMessages.set(message.sessionID, (activeMessages.get(message.sessionID) ?? 0) + 1);
      try {
        const admittedParent = await admittedMessageParent(message.sessionID);
        pendingAncestry.delete(pending);
        const isNudge = !admittedParent && await admitNudge(message.sessionID, message.agent,
          message.messageID ?? output.message?.id, textOf((output?.parts ?? []) as MessagePart[]));
        if (!admittedParent && !isNudge) await admitChat(message.sessionID);
        if (admittedParent) childMessages.set(message.sessionID, message.messageID ?? output.message?.id);
        if (!admittedParent && !awaitingNudge.has(message.sessionID)) {
          admittedMessages.set(message.sessionID, message.messageID ?? output.message?.id);
        }
        const owner = message.agent ? ownerByAgent.get(message.agent) : undefined;
        if (owner && !admittedParent) sessions.claim(message.sessionID, owner);
        if (!operator || message.agent !== operator.name || admittedParent) return;
        operatorSessions.claim(message.sessionID, operator);
        await observeOperatorMessage(message.sessionID, textOf((output?.parts ?? []) as MessagePart[]));
      } finally {
        pendingAncestry.delete(pending);
        const remaining = (activeMessages.get(message.sessionID) ?? 1) - 1;
        if (remaining) activeMessages.set(message.sessionID, remaining);
        else activeMessages.delete(message.sessionID);
      }
    },

    /** Owners' top-level sessions start with the skills bootstrap; subagents' child sessions never do. */
    async 'experimental.chat.messages.transform'(_input, output) {
      const firstUser = output.messages.find(message => message.info.role === 'user');
      const part = firstUser?.parts[0];
      if (!firstUser || !part || firstUser.info.role !== 'user' || !ownerByAgent.get(firstUser.info.agent)?.persona) return;
      if (firstUser.parts.some(candidate => candidate.type === 'text' && candidate.text.includes(BOOTSTRAP_MARKER))) return;
      if (await sessions.isChild(firstUser.info.sessionID)) return;
      firstUser.parts.unshift({ ...part, type: 'text', text: bootstrapText(), synthetic: true } as typeof part);
    },

    async 'experimental.chat.system.transform'(context, output) {
      if (!context.sessionID) return;
      const owner = sessions.ownerOf(context.sessionID);
      if (owner) await pushOwnerContext(owner, output.system);
      if (operatorSessions.ownerOf(context.sessionID)) output.system.push(await memoryIndexBlock(memoryDirectory));
    },

    async event({ event }) {
      const typed = event as { type: string; properties: Record<string, any> };
      const isIdle = typed.type === 'session.idle' || (typed.type === 'session.status' && typed.properties.status?.type === 'idle');
      const activityAtEvent = isIdle ? new Map(chatActivity) : undefined;
      if (typed.type === 'session.status' && ['busy', 'retry'].includes(typed.properties.status?.type)) {
        markKnownAncestryActive(String(typed.properties.sessionID));
      }
      frictionEvents.observe(event);
      await observeProvider(event).catch(error => console.warn('provider_health_failed', error instanceof Error ? error.message : String(error)));
      if (isIdle) {
        const sessionID = String(typed.properties.sessionID);
        let ancestor = await parentOf(sessionID).catch(() => undefined);
        while (ancestor) {
          const parent = ancestor;
          await withChatLock(parent, async () => {
            if (chatActivity.get(sessionID) !== activityAtEvent?.get(sessionID)) return;
            pendingChildren.get(parent)?.delete(sessionID);
          });
          ancestor = await parentOf(ancestor).catch(() => undefined);
        }
        await queueIdle(sessionID, activityAtEvent?.get(sessionID)).catch(error => console.warn('plugin_idle_admission_failed', sessionID, error));
        // A child becoming idle may be the last work of a top-level chat.
        ancestor = await parentOf(sessionID).catch(() => undefined);
        while (ancestor) {
          if (chatLeases.has(ancestor)) {
            await queueIdle(ancestor, activityAtEvent?.get(ancestor)).catch(error => console.warn('plugin_idle_admission_failed', ancestor, error));
          }
          ancestor = await parentOf(ancestor).catch(() => undefined);
        }
        return;
      }
      if (typed.type !== 'message.part.updated') return;
      const part = typed.properties.part as ToolPart;
      if (part.type === 'tool' && part.state?.status === 'error' && typeof part.sessionID === 'string') {
        await reconcileFailedTools(part.sessionID).catch(error => console.warn('plugin_tool_reconciliation_failed', error));
      }
      if (part.type !== 'tool' || part.state?.status !== 'completed' || journaledParts.has(part.id)) return;
      const chat = await chatJournalOf(part.sessionID);
      if (chat && await journalToolCall(chat.journal, part, chat.kind)) await observeOperatorToolCall(part);
    },

    tool: {
      ...(operatorJobs && operatorSupervisor ? { [OPERATOR_JOB_TOOL]: operatorJobTool(operatorJobs, operatorSupervisor, input.client, agent => {
        if (agent === operator!.name) return;
        if (ownerByAgent.has(agent)) requireOwner(agent);
        throw new Error('operator_job_operator_only');
      }) } : {}),
      onionsoup_friction: tool({
        description: 'Report unexpected onionsoup engine behavior with expected/actual and reproducible evidence. Host code adds observed failures and origin; repeats are counted, not re-triaged. Do not include secrets.',
        args: {
          summary: tool.schema.string().min(1).max(800), expected: tool.schema.string().min(1).max(800),
          actual: tool.schema.string().min(1).max(800), evidence: tool.schema.string().max(800).optional(),
        },
        async execute(args, context) {
          const owner = requireOwner(context.agent);
          const input = FrictionInput.parse(args);
          const observed = frictionEvents.context(context.sessionID);
          const record = await reportFriction(runtime, {
            owner: owner.id, origin: { sessionID: context.sessionID, directory: context.directory },
            model: observed.model, commit: await engineCommit(), failures: observed.failures,
            input, submissionID: createHash('sha256').update(JSON.stringify([context.sessionID, context.messageID, input])).digest('hex'),
          }).catch(error => {
            if (error instanceof Error && error.message === 'friction_unsafe_text') {
              throw new Error('friction_unsafe_text: remove private keys or patch bodies and describe the failure without their contents');
            }
            throw error;
          });
          return `Recorded ${record.id} (${record.count} report${record.count === 1 ? '' : 's'}). Failure events: ${record.failureContext}. Triage and issue publication are separate gates.`;
        },
      }),
      [WIKI_TOOL]: tool({
        description: WIKI_TOOL_DESCRIPTION,
        args: {
          action: tool.schema.enum(WIKI_ACTIONS),
          path: tool.schema.string().optional().describe('A page, relative to the pages directory, e.g. hosts/selfie.md'),
          to: tool.schema.string().optional().describe('For move: the new path'),
          query: tool.schema.string().optional().describe('For search: the words to find'),
          content: tool.schema.string().optional().describe('For write: the whole page, frontmatter included'),
          reason: tool.schema.string().optional().describe('For write, move and delete: one line; it becomes the commit subject'),
        },
        async execute(args, context) {
          const caller = ownerOrOperator(context.agent);
          return WIKI_TOOL_ACTIONS[args.action]({ wiki: openWiki(runtime), caller, args, context });
        },
      }),
      onionsoup_request_work: tool({
        description: 'Ask another declared owner to change its repository. The receiver accepts or declines, and accepted work uses the ordinary plan approval gate.',
        args: { owner: tool.schema.string(), ...proposalArgs() },
        async execute(args, context) {
          const sender = requireOwner(context.agent);
          const receiver = resolveOwner(args.owner);
          const proposal = ProposedWork.parse(args);
          return JSON.stringify(await requestWork(runtime, sender.id, receiver.id, proposal, undefined, { sessionID: context.sessionID, directory: context.directory }));
        },
      }),
      [INITIATIVE_TOOL]: tool({
        description: 'For managers: plan cross-repository work as an initiative of assignments to your direct reports. "draft" takes the initiative (title, goal, rationale, and assignments, each with an id, the report\'s owner id as to, a proposal, and after: ids whose work must merge first); "update" replaces the draft of initiative id (an edit after submission needs the person again); "submit" asks the person to approve it; "show" and "list" read yours; "cancel-assignment" drops one assignment (and its open work) with a note; "resolve-escalation" settles a report\'s escalation with a note. After approval the runtime sends each assignment to its report as its dependencies merge.',
        args: {
          action: tool.schema.enum(['draft', 'update', 'submit', 'show', 'list', 'cancel-assignment', 'resolve-escalation']),
          id: tool.schema.string().optional().describe('The initiative id, e.g. i-20260924-1a2b3c'),
          initiative: tool.schema.object({
            title: tool.schema.string(), goal: tool.schema.string(), rationale: tool.schema.string(),
            assignments: tool.schema.array(tool.schema.object({
              id: tool.schema.string().describe('Short, lowercase, e.g. core-doc'),
              to: tool.schema.string().describe('The report\'s owner id'),
              after: tool.schema.array(tool.schema.string()).optional().describe('Assignment ids whose work must merge first'),
              proposal: tool.schema.object(proposalArgs()),
            })),
          }).optional().describe('For draft and update: the whole initiative'),
          assignment: tool.schema.string().optional().describe('For cancel-assignment: the assignment id'),
          escalation: tool.schema.string().optional().describe('For resolve-escalation: the escalation id, e.g. e-1a2b3c4d'),
          note: tool.schema.string().optional().describe('For cancel-assignment: why; for resolve-escalation: how it was settled'),
        },
        async execute(args, context) {
          const manager = requireOwner(context.agent);
          return initiativeActions[args.action](manager.id, args, { sessionID: context.sessionID, directory: context.directory });
        },
      }),
      onionsoup_remind: tool({
        description: 'Set a one-off reminder for yourself: when it is due, the runtime opens a new session of yours with your prompt (and the work item, if you name one). Use it when finished work needs a later check (retention, a rollout settling, a date) instead of promising to check back. "set" takes after (e.g. 30m, 6h, 15d) or at (an ISO date or time), a prompt written for your later self, and optionally an item; "list" shows your pending reminders; "cancel" drops one by id with an optional reason. Recurring checks are duties, not reminders.',
        args: {
          action: tool.schema.enum(['set', 'list', 'cancel']),
          after: tool.schema.string().optional().describe('For set: how long from now, e.g. 30m, 6h or 15d'),
          at: tool.schema.string().optional().describe('For set, instead of after: when, as an ISO date or time'),
          prompt: tool.schema.string().optional().describe('For set: what to check and why, for the session that opens then'),
          item: tool.schema.string().optional().describe('For set: the work item it is about (yours or a direct report\'s)'),
          id: tool.schema.string().optional().describe('For cancel: the reminder id, e.g. m-20260925-1a2b3c'),
          reason: tool.schema.string().optional().describe('For cancel: why'),
        },
        async execute(args, context) {
          const owner = requireOwner(context.agent);
          return remindActions[args.action](owner.id, args, { sessionID: context.sessionID, directory: context.directory });
        },
      }),
      [REQUEST_REVIEW_TOOL]: tool({
        description: 'Review a direct request you sent to your report under an existing applicable approve-plans grant. Read onionsoup_status request first. Bind the verdict to its exact request/item/digest. Approval requires a factual matched-scope assessment; unresolved assumptions or extra scope require needs-human. This does not grant new authority or merge permission.',
        // OpenCode bundles a different Zod minor; adapt its transport schemas, then parse the canonical host input.
        args: {
          request: tool.schema.string(), item: tool.schema.string(), digest: tool.schema.string(),
          decision: tool.schema.enum(DirectRequestPlanReviewInput.shape.decision.options),
          scope: tool.schema.enum(DirectRequestPlanReviewInput.shape.scope.options),
          note: tool.schema.string().describe('Scope evidence, revision feedback, or the exact human decision needed'),
        },
        async execute(args, context) {
          const reviewer = requireOwner(context.agent);
          const item = await reviewDirectRequestPlan(runtime, reviewer.id, args);
          return `Review ${args.decision} recorded for ${args.request}, ${item.id}: ${item.status}. ${item.reason ?? ''}`;
        },
      }),
      [STEER_TOOL]: tool({
        description: 'For managers: act on work a report does for one of your initiatives. "approve-plan" approves its waiting plan (only under the person\'s approve-plans grant, and not while the report has an open escalation); "revise-plan" sends the plan back with your note; "cancel" cancels the work with a reason; "note" leaves the report a note in its journal.',
        args: {
          item: tool.schema.string().describe('The work item id'),
          action: tool.schema.enum(STEER_ACTIONS as [typeof STEER_ACTIONS[number], ...typeof STEER_ACTIONS]),
          note: tool.schema.string().optional().describe('Required except for approve-plan'),
        },
        async execute(args, context) {
          const manager = requireOwner(context.agent);
          const outcome = await steerReportItem(runtime, manager.id, args.item, args.action, args.note ?? '');
          return `${args.action} on ${args.item}: ${outcome}.`;
        },
      }),
      [RAISE_TOOL]: tool({
        description: 'Push back to your manager on an assignment: an objection (it is wrong), a question (it is unclear) or blocked (you cannot proceed). Name your work item, or the initiative and assignment ids. Your manager is woken to answer, and cannot approve that assignment\'s plans until the escalation is resolved.',
        args: {
          kind: tool.schema.enum(['objection', 'question', 'blocked']),
          note: tool.schema.string(),
          item: tool.schema.string().optional().describe('Your work item id for the assignment'),
          initiative: tool.schema.string().optional(),
          assignment: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const report = requireOwner(context.agent);
          const escalation = await raiseToManager(runtime, report.id, args);
          return `Raised ${escalation.id} to your manager on ${escalation.assignment}. They are woken in their chat to answer.`;
        },
      }),
      onionsoup_attention: tool({
        description: 'List your attention items, or acknowledge, resolve, or reopen one with a reason. Resolution records an outcome; it does not authorize effects.',
        args: {
          id: tool.schema.string().optional(),
          action: tool.schema.enum(['list', 'acknowledge', 'resolve', 'reopen']).default('list'),
          reason: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const owner = requireOwner(context.agent);
          const entries = (await listAttention(runtime)).filter(entry => entry.owner === owner.id);
          if (args.action === 'list') return JSON.stringify(entries);
          if (!entries.some(entry => entry.id === args.id)) throw new Error('attention_not_yours');
          const statuses = { acknowledge: 'acknowledged', resolve: 'resolved', reopen: 'open' } as const;
          return JSON.stringify(await changeAttention(runtime, args.id!, statuses[args.action], owner.id, args.reason ?? ''));
        },
      }),
      onionsoup_status: tool({
        description: 'Your open work items and requests (including anything waiting on the person), your initiatives if you manage owners, and work that finished recently with its outcome. Pass a work item id to see that item in full (yours, or any work of your direct reports).',
        args: {
          item: tool.schema.string().optional().describe('A work item id, e.g. w-20260923-31a48a'),
          request: tool.schema.string().optional().describe('A visible request ID for complete linked progress and blocker details'),
          offset: tool.schema.number().int().nonnegative().optional().describe('Next cross-owner progress page offset shown by status'),
        },
        async execute(args, context) {
          const owner = requireObservationOwner(context.agent);
          if (args.request) return requestProgressDetail(runtime, owner.id, args.request);
          if (!args.item) return workSummary(owner.id, args.offset);
          const item = await runtime.ledger.get(args.item).catch(() => undefined);
          const isVisible = item && (item.owner === owner.id || isDirectReport(runtime.declarations, owner.id, item.owner));
          if (!item || !isVisible) return `No work item ${args.item} of yours or your reports'. Your status:\n\n${await workSummary(owner.id)}`;
          const revision = await planRevisionStatus(runtime, item.id);
          return itemText(item) + (revision ? `\nPlan revision delivery: ${revision.status}${revision.reason ? ` (${revision.reason})` : ''}` : '');
        },
      }),
      onionsoup_notebook: tool({
        description: 'Read your notebook: the whole orientation, or one register (CHARTER, MAP, WISDOM, FAILURES, decisions, open-questions).',
        args: { register: tool.schema.enum(['all', 'CHARTER', 'MAP', 'WISDOM', 'FAILURES', 'decisions', 'open-questions']).default('all') },
        async execute(args, context) {
          const notebook = runtime.notebook(requireObservationOwner(context.agent).id);
          if (args.register === 'all') return notebook.orientation();
          return args.register === 'CHARTER' ? notebook.charterText() : readFile(join(notebook.directory, `${args.register}.md`), 'utf8');
        },
      }),
      onionsoup_evidence: tool({
        description: "Another owner's latest recorded observations: its incus snapshot if it holds incus, and its notebook MAP.",
        args: { owner: tool.schema.string().describe('The owner id or persona name, e.g. homelab or Miles Teg') },
        async execute(args, context) {
          requireObservationOwner(context.agent);
          const other = resolveOwner(args.owner);
          const snapshot = hasIncus(other) ? await readFile(join(runtime.evidenceDirectory(other.id), 'SNAPSHOT.md'), 'utf8').catch(() => '') : '';
          const map = await readFile(join(runtime.notebook(other.id).directory, 'MAP.md'), 'utf8').catch(() => '');
          return [snapshot && `<incus-snapshot>\n${snapshot}</incus-snapshot>`, map && `<${other.id}-map>\n${map}</${other.id}-map>`].filter(Boolean).join('\n\n') || `${other.id} has recorded no evidence yet.`;
        },
      }),
      onionsoup_ask: tool({
        description: 'Ask another owner about its domain. Set followUp only when requesting action: its read-only consultation may propose one repository change, which host code queues through ordinary receiver acceptance and plan approvals. Missing evidence remains explicit. Takes a minute or two.',
        args: {
          owner: tool.schema.string().describe('The owner id or persona name, e.g. Miles Teg'),
          question: tool.schema.string(),
          followUp: tool.schema.boolean().optional().describe('Explicitly request a proposed repository fix and durable gated work request; omit for information only'),
        },
        async execute(args, context) {
          const asker = requireObservationOwner(context.agent);
          if (!asker.persona && args.followUp) throw new Error('owner_chat_observation_only');
          context.metadata({ title: `asking ${args.owner}` });
          const followUp = args.followUp ? { origin: { sessionID: context.sessionID, messageID: context.messageID, directory: context.directory } } : undefined;
          const { answerer, answer, request, handoffStatus } = await askOwner(runtime, asker.id, args.owner, args.question, followUp);
          const status = request ? `\nFollow-up request ${request.id}: ${request.status}. Receiver acceptance and ordinary plan/effect gates still apply.` : handoffStatus ? `\nFollow-up ${handoffStatus.state}: ${handoffStatus.reason ?? 'no work proposed'}.` : '';
          return formatAnswer(answerer, answer) + status;
        },
      }),
      onionsoup_propose_changes: tool({
        description: 'Turn the changes on your desk, or in an approved plan\'s own worktree (with its item), into a reviewed change: host code verifies them, a reviewer from another model family checks the diff, and only then they are committed, pushed and opened as a PR (merged, and published if you host a site, when the person granted you merge authority). Takes a few minutes.',
        args: {
          draft: tool.schema.boolean().optional().describe('Create a draft PR and suppress merging/site publication even with a merge grant; retained across retries'),
          title: tool.schema.string(),
          summary: tool.schema.string().describe('What changed and why, for the reviewer and the PR'),
          repository: tool.schema.string().optional().describe('Only if you own several repositories: which desk to propose from (owner/name)'),
          item: tool.schema.string().optional().describe('The approved plan these changes carry out (its own worktree is proposed), or the work item whose open PR they repair from your desk (after onionsoup_checkout_pr)'),
        },
        async execute(args, context) {
          const owner = requireOwner(context.agent);
          context.metadata({ title: `proposing: ${args.title}` });
          const origin = { sessionID: context.sessionID, directory: context.directory };
          const result = await proposeDeskChanges(runtime, owner.id, { ...args, origin });
          return `${result.outcome}: ${result.summary}`;
        },
      }),
      onionsoup_checkout_pr: tool({
        description: 'Put your desk on the head of one of your open PRs (by its work item), to change its content, for example when its CI fails or review asks for a fix. Conflicts with the base branch are not yours to resolve: your maintain-prs duty rebases the PR, and onionsoup_sync_desk refuses while the desk is on a PR. Your desk must have no uncommitted changes. Then fix, verify and propose with onionsoup_propose_changes with the same item: host code reviews the fix and pushes it onto that PR.',
        args: { item: tool.schema.string().describe('The work item whose PR you repair') },
        async execute(args, context) {
          const owner = requireOwner(context.agent);
          const desk = await checkoutPullRequest(runtime, owner.id, args.item);
          return `Your desk ${desk.path} is on ${desk.pullRequest} at ${desk.head.slice(0, 12)}. Fix it there, then propose with item "${args.item}".`;
        },
      }),
      onionsoup_sync_desk: tool({
        description: 'Bring your desk, or an approved plan\'s own worktree (with item), up to date with its base branch (origin), keeping your uncommitted work: host code sets it aside, moves the worktree and restores it, and names any files that conflict. Use it before starting work and whenever it is behind; never pull, stash or reset with git yourself.',
        args: {
          repository: tool.schema.string().optional().describe('Only if you own several repositories: which desk (owner/name)'),
          item: tool.schema.string().optional().describe('The approved plan whose worktree to sync, instead of your desk'),
        },
        async execute(args, context) {
          const owner = requireOwner(context.agent);
          context.metadata({ title: args.item ? `syncing plan ${args.item}` : 'syncing desk' });
          const sync = args.item ? syncPlanWorktree(runtime, owner.id, args.item) : syncOwnerDesk(runtime, owner.id, args.repository);
          return deskSyncText(await sync);
        },
      }),
      onionsoup_submit_plan: tool({
        description: 'Submit a plan for approval: host code records it as a work item and asks the person in this chat (delegated work waits in their inbox). Never approve your own plan. A rejection comes back with the person\'s note: revise and submit again with item. An approved plan runs in its own new session, which ends with onionsoup_propose_changes for the item.',
        args: {
          title: tool.schema.string(),
          goal: tool.schema.string().describe('What the work achieves, in one or two sentences'),
          plan: tool.schema.string().describe('The whole plan in markdown: tasks, files, tests and verification'),
          repository: tool.schema.string().optional().describe('Only if you own several repositories: which one (owner/name)'),
          item: tool.schema.string().optional().describe('The work item of a plan you are revising or were asked to plan'),
        },
        async execute(args, context) {
          const owner = requireOwner(context.agent);
          const item = await submitPlan(runtime, owner.id, PlanSubmission.parse(args), { sessionID: context.sessionID, directory: context.directory });
          return requestPlanApproval(runtime, sessionClient(), item, context);
        },
      }),
      onionsoup_ship: tool({
        description: 'Deploy your repository where it runs: fast-forward the running checkout, install and verify it in the sandbox (rolling back on failure), then restart its services with a health check and automatic rollback. Needs a ship grant or the person\'s approval.',
        args: {},
        async execute(_args, context) {
          const owner = requireOwner(context.agent);
          const repository = runtime.repositoryOwner(owner.id);
          if (!hasShipGrant(repository)) await context.ask({ permission: 'onionsoup_ship', patterns: [repository.domain.name], always: [], metadata: { repository: repository.domain.name } });
          const result = await shipEngine(runtime, owner.id);
          return `${result.outcome}: ${result.summary}`;
        },
      }),
      [STEWARD_TOOL]: tool({
        description: `For stewards: create, change and retire owners within your scope. Start with action "guide" (the procedure, the owners that exist, model families). Use "show" to read an owner's declaration and charter before changing it. "write" takes the full YAML declaration (and a charter for a new owner); "retire" takes an id and a reason. Host code validates everything and refuses authority fields (grants, deploy, incus, mcp, manages); the person approves every write and retirement. Show the person what you will write before calling "write".`,
        args: {
          action: tool.schema.enum(['guide', 'show', 'write', 'retire']),
          id: tool.schema.string().optional().describe('The owner id, for show and retire'),
          declaration: tool.schema.string().optional().describe('For write: the complete owners/<id>.yaml text'),
          charter: tool.schema.string().optional().describe('For write: the complete charters/<id>.md text (required for a new owner)'),
          reason: tool.schema.string().optional().describe('For retire: why'),
        },
        async execute(args, context) {
          const steward = requireOwner(context.agent);
          if (args.action === 'guide') return stewardGuide(runtime, steward.id);
          if (args.action === 'show') return ownerFiles(runtime, required(args.id, 'id'));
          if (args.action === 'write') {
            const prepared = await prepareOwnerWrite(runtime, steward.id, required(args.declaration, 'declaration'), args.charter);
            const verb = prepared.created ? 'create' : 'update';
            context.metadata({ title: `${verb} owner ${prepared.candidate.id}` });
            await context.ask({ permission: 'onionsoup_owner_change', patterns: [`${verb} ${prepared.candidate.id}`], always: [], metadata: { action: verb, owner: prepared.candidate.id, files: Object.keys(prepared.files) } });
            const commit = await writeOwner(runtime, steward.id, prepared);
            const name = prepared.candidate.persona?.name ?? prepared.candidate.id;
            return `${prepared.created ? 'Created' : 'Updated'} ${name} (config commit ${commit}). The daemon picks up its duties within a minute, and its desk is made when its chat first opens. The person restarts the surface (systemctl --user restart onionsoup-surface) to chat with ${name}${prepared.created ? ', and should rewrite the charter' : ''}.`;
          }
          const owner = await prepareRetire(runtime, steward.id, required(args.id, 'id'));
          context.metadata({ title: `retire owner ${owner.id}` });
          await context.ask({ permission: 'onionsoup_owner_change', patterns: [`retire ${owner.id}`], always: [], metadata: { action: 'retire', owner: owner.id } });
          const commit = await retireOwner(runtime, steward.id, owner, required(args.reason, 'reason'));
          return `Retired ${owner.persona?.name ?? owner.id}: its declaration moved to retired/ (config commit ${commit}); its notebook and desk are kept. The daemon stops its duties within a minute.`;
        },
      }),
      onionsoup_request_publish: tool({
        description: 'Ask the owner that hosts one of your sites (e.g. homelab-wiki on the NAS) to publish it from your base branch. Publish only after changes are merged.',
        args: { site: tool.schema.string(), purpose: tool.schema.string().describe('What changed and why it should go live') },
        async execute(args, context) {
          const owner = requireOwner(context.agent);
          const request = await requestPublish(runtime, owner.id, args.site, args.purpose);
          return `Opened ${request.id}. The host owner decides, then it is published (a standing grant may pre-approve it) and verified; check onionsoup_status.`;
        },
      }),
      onionsoup_record_decision: tool({
        description: "Record a decision the person made or explicitly agreed to, quoting their exact words. It goes to your journal; distill decides what enters decisions.md.",
        args: { statement: tool.schema.string(), quote: tool.schema.string() },
        async execute(args, context) {
          const owner = requireOwner(context.agent);
          const notebook = runtime.notebook(owner.id);
          await notebook.journal({ kind: 'chat-decision', outcome: 'recorded-by-owner', note: args.statement, quote: args.quote, session: context.sessionID });
          await commitQuietly(notebook, 'chat decision');
          return 'Recorded in your journal.';
        },
      }),
      onionsoup_record_fact: tool({
        description: 'Record a fact you observed in your domain, or a ruling you made while working, with its source. You read recorded facts word for word in every turn; distill keeps them in your notebook.',
        args: {
          fact: tool.schema.string().describe('The fact, in one or two sentences, as a subagent or a later you should read it'),
          source: tool.schema.string().describe('Where you observed it: a file, a command and its output, a URL, an owner, or the task it belongs to'),
          observedAt: tool.schema.string().optional().describe('When you observed it (ISO date or time); now if left out'),
        },
        async execute(args, context) {
          const owner = requireOwner(context.agent);
          const notebook = runtime.notebook(owner.id);
          const observedAt = args.observedAt ?? new Date().toISOString();
          await notebook.journal({ kind: 'fact', note: args.fact, source: args.source, observedAt, session: context.sessionID });
          await commitQuietly(notebook, 'fact');
          return 'Recorded in your journal; it is in your context from the next turn on.';
        },
      }),
      onionsoup_retract: tool({
        description: 'Retract something noted from this chat that the person says was not a decision.',
        args: { what: tool.schema.string().describe('What to retract, in the words it was noted') },
        async execute(args, context) {
          const owner = requireOwner(context.agent);
          const notebook = runtime.notebook(owner.id);
          await notebook.journal({ kind: 'retracted', note: args.what, session: context.sessionID });
          await commitQuietly(notebook, 'retraction');
          return 'Retracted; distill will drop it.';
        },
      }),
    },
  };
};

export default { id: 'onionsoup-owners', server };
