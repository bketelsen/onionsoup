import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { HostError, respondJson, type JobHost, type RouteHandler } from '@onionsoup/job-host';
import { openChatSession, chatTurn, closeChatSession, hash, type ChatHandle, type ChatSession } from '@onionsoup/chat';
import { createHostChatProfile, type HostCaller } from '@onionsoup/host-chat';
import type { ModelResolver } from '@onionsoup/providers';

const SessionId = z.uuid();
const TurnRequest = z.object({ message: z.string().min(1).max(8000) }).strict();
const Owner = z.object({ principal: z.string() }).strict();

export type ChatServiceOptions = {
  host: JobHost;
  /** Sessions live under <directory>/<sessionId>/ with an owner sidecar. */
  directory: string;
  /** Opens the chat agent's model; the assignment may change between turns. */
  models: ModelResolver;
  /** Whether chat may run interactive capabilities when the person asks. Default true. */
  allowInteractive?: boolean;
};

/** Persistent chat sessions over the job host, one directory per session, opened lazily and closed on shutdown. */
export function createChatService(options: ChatServiceOptions) {
  const { host } = options;
  const handles = new Map<string, ChatHandle>();

  const caller = (principal: string): HostCaller => ({
    discover: () => host.discover(principal),
    submit: (request) => host.submit(principal, request),
    inspect: (jobId) => host.inspect(principal, jobId),
    list: () => host.list(principal),
    cancel: (jobId) => host.cancel(principal, jobId),
  });
  const profileFor = (principal: string) => createHostChatProfile({ bindingHash: hash({ profile: 'host', principal }), host: caller(principal), allowInteractive: options.allowInteractive });

  const chatModel = async () => {
    const adapter = await options.models('chat');
    return { provider: adapter.provider, modelId: adapter.modelId };
  };

  async function ownerOf(sessionId: string) {
    try {
      return Owner.parse(JSON.parse(await readFile(join(options.directory, sessionId, 'owner.json'), 'utf8'))).principal;
    } catch {
      return undefined;
    }
  }

  async function open(principal: string, sessionId: string) {
    const existing = handles.get(sessionId);
    if (existing) return existing;
    if ((await ownerOf(sessionId)) !== principal) throw new HostError('session_not_found', 404);
    const handle = await openChatSession({ directory: join(options.directory, sessionId), profile: profileFor(principal), ...(await chatModel()), resume: true });
    handles.set(sessionId, handle);
    return handle;
  }

  async function create(principal: string) {
    const sessionId = randomUUID();
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const handle = await openChatSession({ directory: join(options.directory, sessionId), profile: profileFor(principal), ...(await chatModel()) });
    await writeFile(join(options.directory, sessionId, 'owner.json'), JSON.stringify({ principal }), { mode: 0o600 });
    handles.set(sessionId, handle);
    return { sessionId, session: handle.session };
  }

  const summary = (sessionId: string, session: ChatSession) => ({
    sessionId,
    createdAt: session.createdAt,
    turns: session.turns.length,
    title: session.turns[0]?.message.slice(0, 80) ?? 'New conversation',
    lastAt: session.turns.at(-1)?.finishedAt ?? session.createdAt,
  });

  async function list(principal: string) {
    let names: string[] = [];
    try { names = await readdir(options.directory); } catch { return []; }
    const sessions = [];
    for (const name of names) {
      if (!SessionId.safeParse(name).success || (await ownerOf(name)) !== principal) continue;
      try {
        const session = handles.get(name)?.session ?? JSON.parse(await readFile(join(options.directory, name, 'session.json'), 'utf8')) as ChatSession;
        sessions.push(summary(name, session));
      } catch { /* an unreadable session is skipped, not fatal */ }
    }
    return sessions.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  const routes: RouteHandler = async ({ req, res, principal, url, body }) => {
    if (!url.startsWith('/v1/chat/')) return false;
    if (req.method === 'GET' && url === '/v1/chat/sessions') { respondJson(res, 200, { sessions: await list(principal) }); return true; }
    if (req.method === 'POST' && url === '/v1/chat/sessions') { respondJson(res, 201, await create(principal)); return true; }
    const match = /^\/v1\/chat\/sessions\/([0-9a-f-]{36})(\/turns)?$/.exec(url);
    if (!match) return false;
    const sessionId = match[1];
    if (req.method === 'GET' && !match[2]) {
      const handle = await open(principal, sessionId);
      respondJson(res, 200, { sessionId, session: handle.session, busy: handle.busy });
      return true;
    }
    if (req.method === 'POST' && match[2]) {
      const { message } = TurnRequest.parse(await body());
      const handle = await open(principal, sessionId);
      if (handle.busy) throw new HostError('turn_active', 409);
      const adapter = await options.models('chat');
      // The session records the model its latest turn runs on.
      handle.session.provider = adapter.provider;
      handle.session.model = adapter.modelId;
      const turn = await chatTurn(handle, message, { modelFactory: async () => adapter.model });
      respondJson(res, 200, { sessionId, turn });
      return true;
    }
    return false;
  };

  return {
    routes,
    async close() {
      for (const handle of handles.values()) {
        try { await closeChatSession(handle); } catch { /* a busy session keeps its lock; the operator clears it after verifying */ }
      }
      handles.clear();
    },
  };
}
