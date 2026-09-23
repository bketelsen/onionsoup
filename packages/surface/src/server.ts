import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { userInfo } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import type { SurfaceState } from './state.ts';

export const SURFACE_LIMITS = { pollMs: 3_000, reloadMs: 15_000, bodyBytes: 1024 * 1024, heartbeatMs: 25_000 };

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > SURFACE_LIMITS.bodyBytes) throw new HttpError(413, 'body_too_large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

function text(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `missing ${name}`);
  return value;
}

type Handler = (params: Record<string, string>, body: () => Promise<Record<string, unknown>>) => Promise<unknown>;
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:([a-zA-Z]+)/g, (_match, key: string) => {
    keys.push(key);
    return '([^/]+)';
  })}$`);
  return { method, pattern, keys, handler };
}

/**
 * The surface's HTTP server: a JSON API over the surface state and opencode, an event stream for the browser,
 * and the built UI. It listens on localhost only; the opencode password stays on this side.
 */
export function surfaceServer(state: SurfaceState, options: { webRoot: string; by?: string }) {
  const by = options.by ?? userInfo().username;
  const clients = new Set<ServerResponse>();
  const broadcast = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(frame);
  };

  const owned = async (ownerId: string) => {
    if (!state.runtime.declarations.owners.has(ownerId)) throw new HttpError(404, `unknown owner: ${ownerId}`);
    return { directory: await state.directory(ownerId), agent: () => state.agentOf(ownerId) };
  };

  const routes: Route[] = [
    route('GET', '/api/state', async () => {
      const inbox = await state.inbox();
      return { owners: await state.owners(inbox), inbox };
    }),
    route('GET', '/api/settings', async () => state.settings.read()),
    route('PUT', '/api/settings/owner-order', async (_params, body) => {
      const order = (await body()).order;
      if (!Array.isArray(order) || !order.every(id => typeof id === 'string')) throw new HttpError(400, 'order must be a list of owner ids');
      const settings = await state.settings.update({ ownerOrder: order as string[] });
      broadcast('onionsoup', { reason: 'settings' });
      return settings;
    }),
    route('GET', '/api/owners/:owner', async params => state.owner(params.owner!)),
    route('GET', '/api/items/:item', async params => state.item(params.item!)),
    route('POST', '/api/decide', async (_params, body) => {
      const input = await body();
      const outcome = await state.decide({
        action: text(input.action, 'action'), id: text(input.id, 'id'),
        note: typeof input.note === 'string' ? input.note : undefined,
        reason: typeof input.reason === 'string' ? input.reason : undefined,
        withDelete: typeof input.withDelete === 'boolean' ? input.withDelete : undefined,
      }, by);
      broadcast('onionsoup', { reason: 'decision' });
      return { outcome };
    }),
    route('POST', '/api/owners/:owner/retract', async (params, body) => {
      await state.retract(params.owner!, text((await body()).note, 'note'));
      return { outcome: 'retracted' };
    }),
    route('GET', '/api/owners/:owner/sessions', async params => {
      const { directory } = await owned(params.owner!);
      const [sessions, status] = await Promise.all([state.opencode.listSessions(directory), state.opencode.status(directory).catch(() => ({}))]);
      return { directory, sessions, status };
    }),
    route('POST', '/api/owners/:owner/sessions', async (params, body) => {
      const { directory, agent } = await owned(params.owner!);
      const input = await body();
      return state.opencode.createSession(directory, typeof input.title === 'string' ? input.title : undefined, agent());
    }),
    route('PATCH', '/api/owners/:owner/sessions/:session', async (params, body) => {
      const { directory } = await owned(params.owner!);
      return state.opencode.renameSession(directory, params.session!, text((await body()).title, 'title'));
    }),
    route('GET', '/api/owners/:owner/sessions/:session/messages', async params => {
      const { directory } = await owned(params.owner!);
      return state.opencode.messages(directory, params.session!);
    }),
    route('POST', '/api/owners/:owner/sessions/:session/prompt', async (params, body) => {
      const { directory, agent } = await owned(params.owner!);
      await state.opencode.prompt(directory, params.session!, agent(), text((await body()).text, 'text'));
      return { outcome: 'sent' };
    }),
    route('POST', '/api/owners/:owner/sessions/:session/abort', async params => {
      const { directory } = await owned(params.owner!);
      await state.opencode.abort(directory, params.session!);
      return { outcome: 'aborted' };
    }),
    route('POST', '/api/owners/:owner/permissions/:request', async (params, body) => {
      const { directory } = await owned(params.owner!);
      const input = await body();
      const reply = input.reply;
      if (reply !== 'once' && reply !== 'always' && reply !== 'reject') throw new HttpError(400, 'reply must be once, always or reject');
      await state.opencode.replyPermission(directory, params.request!, reply, typeof input.message === 'string' ? input.message : undefined);
      return { outcome: reply };
    }),
    route('POST', '/api/owners/:owner/questions/:request', async (params, body) => {
      const { directory } = await owned(params.owner!);
      const input = await body();
      if (input.reject === true) await state.opencode.rejectQuestion(directory, params.request!);
      else if (Array.isArray(input.answers) && input.answers.every(answer => Array.isArray(answer) && answer.every(entry => typeof entry === 'string'))) {
        await state.opencode.replyQuestion(directory, params.request!, input.answers as string[][]);
      } else throw new HttpError(400, 'answers must be a list of lists of strings, or reject: true');
      return { outcome: 'answered' };
    }),
  ];

  const events = (request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    response.write(`event: hello\ndata: {}\n\n`);
    clients.add(response);
    request.on('close', () => clients.delete(response));
  };

  const serveStatic = async (pathname: string, response: ServerResponse) => {
    const root = resolve(options.webRoot);
    const candidate = resolve(join(root, normalize(decodeURIComponent(pathname))));
    const file = candidate.startsWith(root) && (await stat(candidate).then(entry => entry.isFile(), () => false)) ? candidate : join(root, 'index.html');
    if (!(await stat(file).then(entry => entry.isFile(), () => false))) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('The surface UI is not built: run `npm run surface:build`.');
      return;
    }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable' });
    createReadStream(file).pipe(response);
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      try {
        if (url.pathname === '/api/events') return events(request, response);
        if (url.pathname.startsWith('/api/')) {
          for (const candidate of routes) {
            const match = request.method === candidate.method ? candidate.pattern.exec(url.pathname) : null;
            if (!match) continue;
            const params = Object.fromEntries(candidate.keys.map((key, index) => [key, decodeURIComponent(match[index + 1]!)]));
            return send(response, 200, await candidate.handler(params, () => readJson(request)));
          }
          throw new HttpError(404, `no route: ${request.method} ${url.pathname}`);
        }
        await serveStatic(url.pathname, response);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (!response.headersSent) send(response, status, { error: error instanceof Error ? error.message : String(error) });
        else response.end();
      }
    })();
  });

  /** Relay opencode's events and announce engine changes, until the signal aborts. */
  const pump = (signal: AbortSignal) => {
    void state.opencode.events(event => broadcast('opencode', event), signal);
    let last = '';
    let lastReload = Date.now();
    const poll = setInterval(() => {
      void (async () => {
        if (Date.now() - lastReload > SURFACE_LIMITS.reloadMs) {
          lastReload = Date.now();
          await state.runtime.reloadDeclarations().catch(() => undefined);
        }
        const fingerprint = await state.fingerprint().catch(() => last);
        if (fingerprint !== last) {
          if (last) broadcast('onionsoup', { reason: 'engine' });
          last = fingerprint;
        }
      })();
    }, SURFACE_LIMITS.pollMs);
    const heartbeat = setInterval(() => {
      for (const client of clients) client.write(': ping\n\n');
    }, SURFACE_LIMITS.heartbeatMs);
    signal.addEventListener('abort', () => {
      clearInterval(poll);
      clearInterval(heartbeat);
      for (const client of clients) client.end();
    });
  };

  return { server, pump, broadcast };
}
