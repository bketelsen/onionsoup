import type { Plugin } from '@opencode-ai/plugin';
import { z } from 'zod';
import { OPERATOR_INVESTIGATOR, type OperatorClientOptions, type OperatorSessionMessage, type OperatorSupervisorClient } from './operator-jobs-types.ts';

export const OPERATOR_SUPERVISOR_TRANSPORT_LIMITS = { timeoutMs: 10_000 };
export const OPERATOR_CHILD_PERMISSION = [
  { permission: '*', pattern: '*', action: 'deny' },
  ...['read', 'glob', 'grep', 'list'].map(permission => ({ permission, pattern: '*', action: 'allow' })),
  { permission: 'external_directory', pattern: '*', action: 'deny' },
] as const;
const Session = z.object({ id: z.string(), title: z.string(), directory: z.string(), parentID: z.string().optional() });
const Statuses = z.record(z.string(), z.object({ type: z.enum(['idle', 'busy', 'retry']) }));
const ToolPart = z.object({ type: z.literal('tool'), callID: z.string(), tool: z.string(),
  state: z.object({ status: z.enum(['pending', 'running', 'completed', 'error']) }) });
const TextPart = z.object({ type: z.literal('text'), text: z.string() });
const Message = z.object({
  info: z.object({ id: z.string(), sessionID: z.string(), role: z.enum(['user', 'assistant']),
    parentID: z.string().optional(), finish: z.string().optional(), time: z.object({ completed: z.number().finite().optional() }),
    error: z.object({ name: z.string() }).optional() }),
  parts: z.array(z.unknown()),
});
type Message = z.infer<typeof Message>;

function tools(message: Message): OperatorSessionMessage['tools'] {
  return message.parts.flatMap(part => {
    if (!part || typeof part !== 'object' || !('type' in part) || part.type !== 'tool') return [];
    const parsed = ToolPart.parse(part);
    return [{ callID: parsed.callID, tool: parsed.tool, status: parsed.state.status }];
  });
}

function messages(raw: unknown, sessionID: string): OperatorSessionMessage[] {
  const parsed = Message.array().parse(raw);
  if (parsed.some(message => message.info.sessionID !== sessionID)) throw new Error('operator_child_transcript_session_mismatch');
  const projected = parsed.map(message => ({
    id: message.info.id, role: message.info.role, parentID: message.info.parentID, error: message.info.error?.name,
    completed: message.info.role === 'assistant' && message.info.time.completed !== undefined
      && ['stop', 'end_turn'].includes(message.info.finish ?? '') && !message.info.error,
    text: message.parts.flatMap(part => {
      const text = TextPart.safeParse(part);
      return text.success ? [text.data.text] : [];
    }).join('\n'), tools: tools(message),
  }));
  for (const message of projected) {
    const turnHasRunningTools = projected.some(candidate => candidate.role === 'assistant' && candidate.parentID === message.parentID
      && candidate.tools.some(tool => tool.status === 'pending' || tool.status === 'running'));
    if (turnHasRunningTools) message.completed = false;
  }
  return projected;
}

/** Top-level sessions have durable logical parents in the job ledger, never native parent admission coupling. */
export function operatorSupervisorClient(client: Parameters<Plugin>[0]['client'], limits: Partial<typeof OPERATOR_SUPERVISOR_TRANSPORT_LIMITS> = {}): OperatorSupervisorClient {
  const timeoutMs = z.number().int().positive().parse(limits.timeoutMs ?? OPERATOR_SUPERVISOR_TRANSPORT_LIMITS.timeoutMs);
  function budget(options?: OperatorClientOptions) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    signal.throwIfAborted();
    return signal;
  }
  async function session(directory: string, sessionID: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const reply = await client.session.get({ path: { id: sessionID }, query: { directory }, signal });
    signal.throwIfAborted();
    if (reply.error) throw new Error('operator_child_session_unavailable');
    const current = Session.parse(reply.data);
    if (current.id !== sessionID || current.directory !== directory || current.parentID) throw new Error('operator_child_session_binding_mismatch');
    return current;
  }
  return {
    async listSessions(directory, options) {
      const signal = budget(options);
      const reply = await client.session.list({ query: { directory }, signal });
      signal.throwIfAborted();
      if (reply.error) throw new Error('operator_child_sessions_unavailable');
      return Session.array().parse(reply.data).filter(current => current.directory === directory && !current.parentID)
        .map(current => ({ id: current.id, title: current.title }));
    },
    async createSession(directory, title, options) {
      const signal = budget(options);
      // The installed runtime accepts native permission rules; the vendored SDK's create shape predates them.
      const body = { title, permission: OPERATOR_CHILD_PERMISSION };
      const reply = await client.session.create({ query: { directory }, body, signal });
      signal.throwIfAborted();
      if (reply.error) throw new Error('operator_child_create_uncertain');
      const created = Session.parse(reply.data);
      if (created.directory !== directory || created.title !== title || created.parentID) throw new Error('operator_child_create_binding_mismatch');
      return { id: created.id };
    },
    async readSession(directory, sessionID, options) {
      const signal = budget(options);
      await session(directory, sessionID, signal);
      const statuses = await client.session.status({ query: { directory }, signal });
      signal.throwIfAborted();
      if (statuses.error) throw new Error('operator_child_status_unavailable');
      const status = Statuses.parse(statuses.data)[sessionID]?.type ?? 'idle';
      const transcript = await client.session.messages({ path: { id: sessionID }, query: { directory }, signal });
      signal.throwIfAborted();
      if (transcript.error) throw new Error('operator_child_transcript_unavailable');
      return { status, messages: messages(transcript.data, sessionID) };
    },
    async prompt(directory, sessionID, messageID, text, options) {
      const signal = budget(options);
      await session(directory, sessionID, signal);
      const reply = await client.session.promptAsync({ path: { id: sessionID }, query: { directory },
        body: { agent: OPERATOR_INVESTIGATOR, messageID, parts: [{ type: 'text', text }] }, signal });
      signal.throwIfAborted();
      if (reply.error) throw new Error('operator_child_prompt_uncertain');
    },
    async abort(directory, sessionID, options) {
      const signal = budget(options);
      await session(directory, sessionID, signal);
      const reply = await client.session.abort({ path: { id: sessionID }, query: { directory }, signal });
      signal.throwIfAborted();
      if (reply.error || reply.data !== true) throw new Error('operator_child_abort_uncertain');
    },
  };
}
