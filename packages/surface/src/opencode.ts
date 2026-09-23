import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';

/**
 * What the surface needs from opencode, kept narrow so tests can fake it. Everything is scoped to a directory:
 * an owner's chats live in its chat directory (desk or evidence folder).
 */
export interface OpencodeApi {
  listSessions(directory: string): Promise<unknown[]>;
  createSession(directory: string, title: string | undefined, agent: string): Promise<unknown>;
  renameSession(directory: string, sessionID: string, title: string): Promise<unknown>;
  messages(directory: string, sessionID: string): Promise<unknown[]>;
  prompt(directory: string, sessionID: string, agent: string, text: string): Promise<void>;
  abort(directory: string, sessionID: string): Promise<void>;
  status(directory: string): Promise<Record<string, unknown>>;
  /** Whether the opencode server answers at all. */
  health(): Promise<{ ok: boolean; error?: string }>;
  permissions(directory: string): Promise<PendingPermission[]>;
  replyPermission(directory: string, requestID: string, reply: 'once' | 'always' | 'reject', message?: string): Promise<void>;
  questions(directory: string): Promise<PendingQuestion[]>;
  replyQuestion(directory: string, requestID: string, answers: string[][]): Promise<void>;
  rejectQuestion(directory: string, requestID: string): Promise<void>;
  /** Every event from every directory, until the signal aborts. Reconnects on its own. */
  events(onEvent: (event: unknown) => void, signal: AbortSignal): Promise<void>;
}

export interface PendingPermission { id: string; sessionID: string; permission: string; patterns: string[]; metadata: Record<string, unknown>; always: string[] }
export interface PendingQuestion { id: string; sessionID: string; questions: { question: string; header: string; options: { label: string; description: string }[]; multiple?: boolean }[] }

export const OPENCODE_LIMITS = { startMs: 30_000, reconnectMs: 2_000 };

function unwrap<T>(result: { data?: T; error?: unknown }, what: string): T {
  if (result.error !== undefined && result.data === undefined) throw new Error(`${what}_failed: ${JSON.stringify(result.error).slice(0, 300)}`);
  return result.data as T;
}

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no_port'))));
    });
  });
}

export interface OpencodeConnection { url: string; api: OpencodeApi; close(): void }

/** Start our own `opencode serve` (it loads the onionsoup plugin from the global config) behind a fresh password. */
async function startServer() {
  const port = await freePort();
  const password = randomBytes(24).toString('base64url');
  const { OPENCODE_SERVER_PASSWORD: _password, OPENCODE_SERVER_USERNAME: _username, ...inherited } = process.env;
  const child: ChildProcess = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...inherited, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`opencode_start_timeout: ${output.slice(-400)}`)), OPENCODE_LIMITS.startMs);
    const watch = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/listening on\s+(https?:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    };
    child.stdout?.on('data', watch);
    child.stderr?.on('data', watch);
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`opencode_exited: ${code} ${output.slice(-400)}`));
    });
  });
  return { url, username: 'opencode', password, close: () => child.kill('SIGTERM') };
}

/** Attach to a running opencode (url and credentials from the environment), or start one. */
export async function connectOpencode(options: { url?: string; username?: string; password?: string }): Promise<OpencodeConnection> {
  const server = options.url
    ? { url: options.url, username: options.username ?? 'opencode', password: options.password, close: () => {} }
    : await startServer();
  const headers: Record<string, string> = server.password
    ? { authorization: `Basic ${Buffer.from(`${server.username}:${server.password}`).toString('base64')}` }
    : {};
  return { url: server.url, api: opencodeApi(server.url, headers), close: server.close };
}

function opencodeApi(url: string, headers: Record<string, string>): OpencodeApi {
  const client = createOpencodeClient({ baseUrl: url, headers });
  return {
    async listSessions(directory) {
      return unwrap(await client.session.list({ directory }), 'session_list') as unknown[];
    },
    async createSession(directory, title, agent) {
      return unwrap(await client.session.create({ directory, title, agent }), 'session_create');
    },
    async renameSession(directory, sessionID, title) {
      return unwrap(await client.session.update({ directory, sessionID, title }), 'session_update');
    },
    async messages(directory, sessionID) {
      return unwrap(await client.session.messages({ directory, sessionID }), 'session_messages') as unknown[];
    },
    async prompt(directory, sessionID, agent, text) {
      unwrap(await client.session.promptAsync({ directory, sessionID, agent, parts: [{ type: 'text', text }] }), 'session_prompt');
    },
    async abort(directory, sessionID) {
      unwrap(await client.session.abort({ directory, sessionID }), 'session_abort');
    },
    async status(directory) {
      return (unwrap(await client.session.status({ directory }), 'session_status') ?? {}) as Record<string, unknown>;
    },
    async health() {
      try {
        const response = await fetch(`${url}/global/health`, { headers, signal: AbortSignal.timeout(3_000) });
        return response.ok ? { ok: true } : { ok: false, error: `opencode at ${url} answered HTTP ${response.status}` };
      } catch (error) {
        return { ok: false, error: `opencode at ${url} is unreachable (${error instanceof Error ? error.message : error})` };
      }
    },
    async permissions(directory) {
      return (unwrap(await client.permission.list({ directory }), 'permission_list') ?? []) as PendingPermission[];
    },
    async replyPermission(directory, requestID, reply, message) {
      unwrap(await client.permission.reply({ directory, requestID, reply, message }), 'permission_reply');
    },
    async questions(directory) {
      return (unwrap(await client.question.list({ directory }), 'question_list') ?? []) as PendingQuestion[];
    },
    async replyQuestion(directory, requestID, answers) {
      unwrap(await client.question.reply({ directory, requestID, answers }), 'question_reply');
    },
    async rejectQuestion(directory, requestID) {
      unwrap(await client.question.reject({ directory, requestID }), 'question_reject');
    },
    async events(onEvent, signal) {
      while (!signal.aborted) {
        try {
          const response = await fetch(`${url}/global/event`, { headers: { ...headers, accept: 'text/event-stream' }, signal });
          if (!response.ok || !response.body) throw new Error(`event_stream_${response.status}`);
          const decoder = new TextDecoder();
          let buffer = '';
          for await (const chunk of response.body) {
            buffer += decoder.decode(chunk as Uint8Array, { stream: true });
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
              if (data) {
                try {
                  onEvent(JSON.parse(data));
                } catch {
                  // A malformed event is skipped; the stream goes on.
                }
              }
            }
          }
        } catch (error) {
          if (signal.aborted) return;
          void error;
        }
        await new Promise(resolve => setTimeout(resolve, OPENCODE_LIMITS.reconnectMs));
      }
    },
  };
}
