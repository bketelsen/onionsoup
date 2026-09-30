import { tool, type Plugin } from '@opencode-ai/plugin';
import { OperatorJobInput, type OperatorJobIntake, type OperatorJobOrigin } from './operator-jobs-types.ts';
import { OperatorJobs, operatorJobDigest } from './operator-jobs.ts';
import type { OperatorSupervisor } from './operator-supervisor.ts';
import { NOTICE_PREFIX } from './notices.ts';
import { abandonOperatorChild, prepareOperatorRecovery } from './operator-job-recovery.ts';
import type { OperatorRecoveryPermissions } from './operator-recovery-permission.ts';
import { OPERATOR_SUPERVISOR_TRANSPORT_LIMITS } from './operator-supervisor-client.ts';

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
  guard: (agent: string) => void, permissions: OperatorRecoveryPermissions): ReturnType<typeof tool> {
  return tool({
    description: 'Supervise your own durable read-only investigations with two managed scheduling slots. Show includes evidence and digest. Pause stops new launches; cancel preserves transcripts; resume with childID continues a proven interrupted child in the same session. Recheck performs one fresh observation. Recovery-preview shows unresolved uncertainty; abandon requires its exact digest, childID, factual text note and a one-time human permission. Abandon releases a reservation without proving earlier inference stopped, never relaunches the child, and creates no grant. Synthesize requires the current digest and all evidence message IDs. No owner delegation or write authority.',
    // OpenCode's bundled Zod differs from the host version; parse with the canonical schema at the boundary.
    args: {
      action: tool.schema.enum(['create', 'list', 'show', 'pause', 'resume', 'cancel', 'synthesize', 'recheck', 'recovery-preview', 'abandon']),
      id: tool.schema.string().optional(), childID: tool.schema.string().optional(),
      job: tool.schema.object({ key: tool.schema.string(), goal: tool.schema.string(), constraints: tool.schema.array(tool.schema.string()),
        tasks: tool.schema.array(tool.schema.object({ id: tool.schema.string(), goal: tool.schema.string(), directory: tool.schema.string(),
          access: tool.schema.literal('read-only'), dependsOn: tool.schema.array(tool.schema.string()).default([]) })) }).optional(),
      digest: tool.schema.string().optional(), evidenceIDs: tool.schema.array(tool.schema.string()).optional(), text: tool.schema.string().optional(),
    },
    async execute(args, context) {
      guard(context.agent);
      const caller = await operatorJobCaller(jobs, client, context, args.action === 'create');
      const required = <T>(value: T | undefined, name: string): T => { if (value === undefined) throw new Error(`operator_job_missing_${name}`); return value; };
      const id = () => required(args.id, 'id');
      const actions = {
        create: () => jobs.create(caller.origin, required(caller.intake, 'intake'), OperatorJobInput.parse(args.job)),
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
      };
      const result = await actions[args.action]();
      if (args.action === 'recovery-preview') return JSON.stringify(result);
      if (Array.isArray(result)) return JSON.stringify(result.map(job => ({ ...job, digest: operatorJobDigest(job) })));
      return JSON.stringify('origin' in result ? { ...result, digest: operatorJobDigest(result) } : result);
    },
  });
}
