import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { HostError, respondJson, type JobHost, type RouteContext, type RouteHandler } from '@onionsoup/job-host';
import { openChatSession, chatTurn, closeChatSession, hash, type ChatHandle, type ChatSession } from '@onionsoup/chat';
import { createHostChatProfile, type HostCaller } from '@onionsoup/host-chat';
import type { ModelResolver } from '@onionsoup/providers';

const SessionId = z.uuid();
const TurnRequest = z.object({ message: z.string().min(1).max(8000) }).strict();
const SessionUpdate = z.object({ title: z.string().trim().min(1).max(120).optional(), archived: z.boolean().optional() }).strict();
/** The sidecar beside each session: who owns it, and what the person renamed or archived. */
const Sidecar = z.object({ principal: z.string(), title: z.string().max(120).optional(), archivedAt: z.iso.datetime().optional() }).strict();
type Sidecar = z.infer<typeof Sidecar>;

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
  /** One abort controller per session with a turn in flight, so the person can stop it. */
  const turns = new Map<string, AbortController>();

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

  const sidecarPath = (sessionId: string) => join(options.directory, sessionId, 'owner.json');

  async function sidecarOf(sessionId: string): Promise<Sidecar | undefined> {
    try {
      return Sidecar.parse(JSON.parse(await readFile(sidecarPath(sessionId), 'utf8')));
    } catch {
      return undefined;
    }
  }

  async function writeSidecar(sessionId: string, sidecar: Sidecar) {
    await writeFile(sidecarPath(sessionId), JSON.stringify(sidecar), { mode: 0o600 });
  }

  async function open(principal: string, sessionId: string) {
    const existing = handles.get(sessionId);
    if (existing) return existing;
    if ((await sidecarOf(sessionId))?.principal !== principal) throw new HostError('session_not_found', 404);
    const handle = await openChatSession({ directory: join(options.directory, sessionId), profile: profileFor(principal), ...(await chatModel()), resume: true });
    handles.set(sessionId, handle);
    return handle;
  }

  async function create(principal: string) {
    const sessionId = randomUUID();
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const handle = await openChatSession({ directory: join(options.directory, sessionId), profile: profileFor(principal), ...(await chatModel()) });
    await writeSidecar(sessionId, { principal });
    handles.set(sessionId, handle);
    return { sessionId, session: handle.session };
  }

  const summary = (sessionId: string, session: ChatSession, sidecar: Sidecar) => ({
    sessionId,
    createdAt: session.createdAt,
    turns: session.turns.length,
    title: sidecar.title ?? session.turns[0]?.message.slice(0, 80) ?? 'New conversation',
    lastAt: session.turns.at(-1)?.finishedAt ?? session.createdAt,
    busy: turns.has(sessionId),
  });

  async function readSession(sessionId: string) {
    return handles.get(sessionId)?.session ?? JSON.parse(await readFile(join(options.directory, sessionId, 'session.json'), 'utf8')) as ChatSession;
  }

  async function list(principal: string) {
    let names: string[] = [];
    try { names = await readdir(options.directory); } catch { return []; }
    const sessions = [];
    for (const name of names) {
      if (!SessionId.safeParse(name).success) continue;
      const sidecar = await sidecarOf(name);
      if (sidecar?.principal !== principal || sidecar.archivedAt) continue;
      try {
        sessions.push(summary(name, await readSession(name), sidecar));
      } catch { /* an unreadable session is skipped, not fatal */ }
    }
    return sessions.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  async function runTurn(principal: string, sessionId: string, message: string) {
    const handle = await open(principal, sessionId);
    if (handle.busy) throw new HostError('turn_active', 409);
    const adapter = await options.models('chat');
    // The session records the model its latest turn runs on.
    handle.session.provider = adapter.provider;
    handle.session.model = adapter.modelId;
    const controller = new AbortController();
    turns.set(sessionId, controller);
    try {
      return await chatTurn(handle, message, { modelFactory: async () => adapter.model, signal: controller.signal });
    } finally {
      turns.delete(sessionId);
    }
  }

  /** Rename or archive. Archived sessions leave the list but stay on disk as the record of what was asked. */
  async function update(principal: string, sessionId: string, change: z.infer<typeof SessionUpdate>) {
    const sidecar = await sidecarOf(sessionId);
    if (sidecar?.principal !== principal) throw new HostError('session_not_found', 404);
    if (change.archived && turns.has(sessionId)) throw new HostError('turn_active', 409);
    const next: Sidecar = { ...sidecar, ...(change.title ? { title: change.title } : {}) };
    if (change.archived === true) next.archivedAt = new Date().toISOString();
    if (change.archived === false) delete next.archivedAt;
    await writeSidecar(sessionId, next);
    return summary(sessionId, await readSession(sessionId), next);
  }

  async function cancel(principal: string, sessionId: string) {
    if ((await sidecarOf(sessionId))?.principal !== principal) throw new HostError('session_not_found', 404);
    const controller = turns.get(sessionId);
    controller?.abort();
    return { cancelled: Boolean(controller) };
  }

  type Route = { method: string; pattern: RegExp; handle: (context: RouteContext, sessionId: string) => Promise<[number, unknown]> };
  /** Chat endpoints, matched in order. The captured group, when present, is the session ID. */
  const table: Route[] = [
    { method: 'GET', pattern: /^\/v1\/chat\/sessions$/, handle: async ({ principal }) => [200, { sessions: await list(principal) }] },
    { method: 'POST', pattern: /^\/v1\/chat\/sessions$/, handle: async ({ principal }) => [201, await create(principal)] },
    { method: 'GET', pattern: /^\/v1\/chat\/sessions\/([0-9a-f-]{36})$/, handle: async ({ principal }, sessionId) => {
      const handle = await open(principal, sessionId);
      return [200, { sessionId, session: handle.session, busy: handle.busy }];
    } },
    { method: 'PATCH', pattern: /^\/v1\/chat\/sessions\/([0-9a-f-]{36})$/, handle: async ({ principal, body }, sessionId) => [200, await update(principal, sessionId, SessionUpdate.parse(await body()))] },
    { method: 'POST', pattern: /^\/v1\/chat\/sessions\/([0-9a-f-]{36})\/turns$/, handle: async ({ principal, body }, sessionId) => {
      const { message } = TurnRequest.parse(await body());
      return [200, { sessionId, turn: await runTurn(principal, sessionId, message) }];
    } },
    { method: 'POST', pattern: /^\/v1\/chat\/sessions\/([0-9a-f-]{36})\/cancel$/, handle: async ({ principal }, sessionId) => [202, await cancel(principal, sessionId)] },
  ];

  const routes: RouteHandler = async (context) => {
    if (!context.url.startsWith('/v1/chat/')) return false;
    for (const route of table) {
      const match = route.method === context.req.method ? route.pattern.exec(context.url) : null;
      if (!match) continue;
      const [status, value] = await route.handle(context, match[1] ?? '');
      respondJson(context.res, status, value);
      return true;
    }
    return false;
  };

  return {
    routes,
    async close() {
      for (const controller of turns.values()) controller.abort();
      for (const handle of handles.values()) {
        try { await closeChatSession(handle); } catch { /* a busy session keeps its lock; the operator clears it after verifying */ }
      }
      handles.clear();
    },
  };
}
