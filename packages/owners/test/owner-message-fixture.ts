import type { Plugin } from '@opencode-ai/plugin';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatOrigin } from '../src/chat-origin.ts';
import type { NoticeMessage } from '../src/exchange-notices.ts';
import { MaintenancePass } from '../src/plugin-maintenance.ts';
import { Runtime } from '../src/runtime.ts';
import { rememberSession } from '../src/session-history.ts';
import { deliverWorkNotices, WorkNoticeDelivery } from '../src/work-notice-delivery.ts';
import { chatPath } from '../src/chats.ts';
import { git } from '../src/workspace.ts';

type Prompt = { path: { id: string }; query: { directory: string };
  body: { agent: string; messageID: string; noReply?: boolean; parts: { type: 'text'; text: string }[] } };
type Session = { id: string; directory: string; title: string; time: { created: number; updated: number; archived?: number } };

export async function messageFixture() {
  const root = await mkdtemp(join(tmpdir(), 'owner-messages-'));
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: join(root, 'state') });
  for (const owner of runtime.declarations.owners.values()) await runtime.notebook(owner.id).ensureJournal();
  const checkout = runtime.owner('homelab').workspace;
  await mkdir(checkout, { recursive: true });
  await git(checkout, ['init', '-q', '-b', 'main']);
  await git(checkout, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '--allow-empty', '-m', 'Fixture']);
  await git(checkout, ['worktree', 'add', '-q', '-b', 'desk/homelab', chatPath(runtime, 'homelab')]);
  const sessions = new Map<string, Session>();
  const transcripts = new Map<string, NoticeMessage[]>();
  const busy = new Set<string>();
  const sends: Prompt[] = [];
  const queries: { method: string; id?: string; directory: string }[] = [];
  let creates = 0;
  let mode: 'accept' | 'reject' | 'lost-reply' | 'unconfirmed' = 'accept';
  let onPrompt: ((prompt: Prompt) => Promise<void>) | undefined;
  const sdk = {
    session: {
      async get({ path, query }: { path: { id: string }; query: { directory: string } }) {
        queries.push({ method: 'get', id: path.id, directory: query.directory });
        const session = sessions.get(path.id);
        return session ? { data: session } : { error: { name: 'NotFoundError' }, response: new Response(null, { status: 404 }) };
      },
      async status({ query }: { query: { directory: string } }) {
        queries.push({ method: 'status', directory: query.directory });
        return { data: Object.fromEntries([...busy].map(id => [id, { type: 'busy' }])) };
      },
      async messages({ path, query }: { path: { id: string }; query: { directory: string } }) {
        queries.push({ method: 'messages', id: path.id, directory: query.directory });
        return { data: transcripts.get(path.id) ?? [] };
      },
      async create({ body, query }: { body: { title: string }; query: { directory: string } }) {
        queries.push({ method: 'create', directory: query.directory });
        creates += 1;
        const session = { id: `ses_continuation_${creates}`, directory: query.directory, title: body.title,
          time: { created: Date.now(), updated: Date.now() } };
        sessions.set(session.id, session);
        return { data: session };
      },
      async promptAsync(prompt: Prompt) {
        queries.push({ method: 'promptAsync', id: prompt.path.id, directory: prompt.query.directory });
        sends.push(prompt);
        if (mode === 'reject') return { error: { name: 'BadRequestError' }, response: new Response(null, { status: 400 }) };
        if (mode !== 'unconfirmed') {
          const messages = transcripts.get(prompt.path.id) ?? [];
          messages.push({ info: { id: prompt.body.messageID, role: 'user', agent: prompt.body.agent, time: { created: Date.now() } },
            parts: prompt.body.parts });
          transcripts.set(prompt.path.id, messages);
          await onPrompt?.(prompt);
        }
        if (mode === 'lost-reply') throw new Error('reply_lost_after_acceptance');
        return { data: {} };
      },
    },
  } as unknown as Parameters<Plugin>[0]['client'];
  const pass = () => new MaintenancePass(join(runtime.stateDirectory, 'test-passes', `${randomUUID()}.json`), {
    version: 1, instanceID: randomUUID(), operationID: randomUUID(), kind: 'plugin:notices', directory: root,
    startedAt: new Date().toISOString(), phase: 'work-notices', status: 'running', calls: [],
  });
  const addSession = async (owner: string, id: string, directory = join(root, id), archived = false): Promise<ChatOrigin> => {
    if (!archived) await mkdir(directory, { recursive: true });
    const session = { id, directory, title: 'Fixture session', time: { created: 1, updated: 1, ...(archived ? { archived: 1 } : {}) } };
    sessions.set(id, session);
    transcripts.set(id, [{ info: { id: `msg_initial_${id}`, role: 'user', agent: runtime.owner(owner).persona!.name,
      time: { created: 1 } }, parts: [{ type: 'text', text: `${owner}'s original context` }] }]);
    await rememberSession(runtime, { ...session, owner, archived });
    return { sessionID: id, directory };
  };
  const receipts = async () => {
    const directory = join(runtime.stateDirectory, 'notices', 'delivery');
    const names = await readdir(directory).catch(() => []);
    return Promise.all(names.filter(name => name.endsWith('.json')).map(async name =>
      WorkNoticeDelivery.parse(JSON.parse(await readFile(join(directory, name), 'utf8')))));
  };
  const deliver = async (engine = runtime, scope = pass()) => {
    await deliverWorkNotices(engine, scope.client(sdk), scope, (_id, error) => { throw error; });
  };
  return { root, runtime, sdk, sessions, transcripts, busy, sends, queries, pass, addSession, receipts, deliver,
    creates: () => creates, setMode: (value: typeof mode) => { mode = value; },
    onPrompt: (callback: typeof onPrompt) => { onPrompt = callback; } };
}
