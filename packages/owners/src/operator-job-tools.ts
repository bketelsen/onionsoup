import { tool, type Plugin } from '@opencode-ai/plugin';
import { OperatorJobInput, type OperatorJobIntake, type OperatorJobOrigin } from './operator-jobs-types.ts';
import { OperatorJobs, operatorJobDigest } from './operator-jobs.ts';
import type { OperatorSupervisor } from './operator-supervisor.ts';
import { NOTICE_PREFIX } from './notices.ts';
import { abandonOperatorChild, prepareOperatorRecovery } from './operator-job-recovery.ts';
import type { OperatorRecoveryPermissions } from './operator-recovery-permission.ts';
import { OPERATOR_SUPERVISOR_TRANSPORT_LIMITS } from './operator-supervisor-client.ts';
import type { OperatorWrites } from './operator-write-host.ts';

export const OPERATOR_JOB_TOOL = 'onionsoup_operator_job';
type Client = Parameters<Plugin>[0]['client'];
interface Caller { agent: string; sessionID: string; messageID: string; directory: string }

/** The model supplies decomposition, never the identity or text of the person's intake. */
export async function operatorJobCaller(jobs: OperatorJobs, client: Client, context: Caller, intake = false) {
  if (context.agent !== jobs.operator) throw new Error('operator_job_operator_only');
  const query = { directory: context.directory };
  const signal = AbortSignal.timeout(OPERATOR_SUPERVISOR_TRANSPORT_LIMITS.timeoutMs);
  const response = await client.session.get({ path: { id: context.sessionID }, query, signal });
  const session = response.data;
  if (response.error || !session || session.parentID || session.id !== context.sessionID
    || session.directory !== context.directory) throw new Error('operator_job_parent_unverified');
  const origin: OperatorJobOrigin = await jobs.origin({ operator: jobs.operator, sessionID: session.id, directory: session.directory });
  if (!intake) return { origin };
  const transcript = await client.session.messages({ path: { id: session.id }, query, signal });
  if (transcript.error || !transcript.data) throw new Error('operator_job_intake_unavailable');
  const current = transcript.data.find(message => message.info.id === context.messageID);
  const userID = current?.info.role === 'user' ? current.info.id : current?.info.role === 'assistant' ? current.info.parentID : undefined;
  const user = transcript.data.find(message => message.info.id === userID && message.info.role === 'user');
  const text = user?.parts.filter(part => part.type === 'text' && !part.synthetic && !part.ignored)
    .map(part => part.type === 'text' ? part.text : '').join('\n').trim();
  if (!user || !text || text.startsWith(NOTICE_PREFIX)) throw new Error('operator_job_human_intake_required');
  return { origin, intake: { messageID: user.info.id, text } satisfies OperatorJobIntake };
}

export function operatorJobTool(jobs: OperatorJobs, supervisor: OperatorSupervisor, client: Client,
  guard: (agent: string) => void, permissions: OperatorRecoveryPermissions, writes?: OperatorWrites): ReturnType<typeof tool> {
  return tool({
    description: 'Supervise your own investigations and explicitly approved named-file edits with two managed slots. Write tasks require access write and files in an existing clean Git workspace, with one-time human approval. Separate workspaces can run in parallel; conflicts refuse. Review-write shows the host diff and review digest; accept-write asks the person to accept that exact diff before releasing its workspace. No child shell, commits, pushes, owner delegation or persistent grants. Show includes evidence and job digest. Pause stops new launches; resume with childID continues a proven interrupted child in the same session. Cancel cannot release unaccepted write claims. Recovery-preview and abandon require explicit human recovery; write children qualify only with zero recorded mutations and verified absent or idle owned runtime state. Any recorded write remains held for review, never replayed. Synthesize requires current job digest and all accepted evidence IDs.',
    // OpenCode's bundled Zod differs from the host version; parse with the canonical schema at the boundary.
    args: {
      action: tool.schema.enum(['create', 'list', 'show', 'pause', 'resume', 'cancel', 'synthesize', 'recheck', 'recovery-preview', 'abandon', 'review-write', 'accept-write']),
      id: tool.schema.string().optional(), childID: tool.schema.string().optional(),
      job: tool.schema.object({ key: tool.schema.string(), goal: tool.schema.string(), constraints: tool.schema.array(tool.schema.string()),
        tasks: tool.schema.array(tool.schema.object({ id: tool.schema.string(), goal: tool.schema.string(), directory: tool.schema.string(),
          access: tool.schema.enum(['read-only', 'write']), files: tool.schema.array(tool.schema.string()).optional(),
          dependsOn: tool.schema.array(tool.schema.string()).default([]) })) }).optional(),
      digest: tool.schema.string().optional(), evidenceIDs: tool.schema.array(tool.schema.string()).optional(), text: tool.schema.string().optional(),
    },
    async execute(args, context) {
      guard(context.agent);
      const caller = await operatorJobCaller(jobs, client, context, args.action === 'create');
      const required = <T>(value: T | undefined, name: string): T => { if (value === undefined) throw new Error(`operator_job_missing_${name}`); return value; };
      const id = () => required(args.id, 'id');
      const create = () => {
        const input = OperatorJobInput.parse(args.job);
        const intake = required(caller.intake, 'intake');
        return input.tasks.some(task => task.access === 'write')
          ? required(writes, 'write_host').create(caller.origin, intake, input, context)
          : jobs.create(caller.origin, intake, input);
      };
      const actions = {
        create,
        list: () => jobs.list(caller.origin),
        show: () => jobs.get(caller.origin, id()),
        pause: () => supervisor.intervene(caller.origin, id(), 'pause'),
        resume: () => supervisor.intervene(caller.origin, id(), 'resume', args.childID),
        cancel: () => supervisor.intervene(caller.origin, id(), 'cancel'),
        recheck: () => supervisor.refresh(caller.origin, id(), required(args.childID, 'childID')),
        'recovery-preview': () => prepareOperatorRecovery(jobs, supervisor.client, caller.origin, id(), required(args.childID, 'childID')),
        abandon: () => abandonOperatorChild(jobs, supervisor.client, caller.origin, id(), required(args.childID, 'childID'),
          required(args.digest, 'digest'), required(args.text, 'text'), context, permissions),
        synthesize: () => jobs.synthesize(caller.origin, id(), required(args.digest, 'digest'), required(args.evidenceIDs, 'evidenceIDs'), required(args.text, 'text')),
        'review-write': async () => {
          const preview = await required(writes, 'write_host').review(caller.origin, id(), required(args.childID, 'childID'));
          return { jobID: id(), childID: args.childID, digest: preview.digest, artifact: preview.artifact,
            originalIntake: preview.job.intake, goal: preview.job.goal, constraints: preview.job.constraints, evidence: preview.child.evidence };
        },
        'accept-write': () => required(writes, 'write_host').accept(caller.origin, id(), required(args.childID, 'childID'),
          required(args.digest, 'digest'), context),
      };
      const result = await actions[args.action]();
      if (args.action === 'recovery-preview' || args.action === 'review-write') return JSON.stringify(result);
      if (Array.isArray(result)) return JSON.stringify(result.map(job => ({ ...job, digest: operatorJobDigest(job) })));
      return JSON.stringify('origin' in result ? { ...result, digest: operatorJobDigest(result) } : result);
    },
  });
}
