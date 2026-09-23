// The Desk's local service. It never touches onionsoup state itself: every read and every decision goes
// through the `owners` CLI, so the Desk records decisions exactly the way the command line does.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

/** onionsoup's location comes from its plugin entry in the global opencode config: one source of truth. */
function findOnionsoup() {
  const config = JSON.parse(readFileSync(join(homedir(), '.config/opencode/opencode.jsonc'), 'utf8'));
  for (const entry of config.plugin ?? []) {
    const [spec, options] = Array.isArray(entry) ? entry : [entry, {}];
    if (String(spec).endsWith('/packages/owners/src/plugin.ts')) {
      const root = resolve(dirname(String(spec).replace('file://', '')), '../../..');
      return { root, declarations: options.declarations, state: options.state };
    }
  }
  throw new Error('onionsoup plugin not found in ~/.config/opencode/opencode.jsonc');
}

const onionsoup = findOnionsoup();

/**
 * OpenChamber runs services on its own runtime (Bun), whose process.execPath cannot load onionsoup's tsx CLI.
 * Find a real Node the way the systemd unit does: mise shims first, then PATH, then system locations.
 */
function findNode() {
  const candidates = [
    join(homedir(), '.local/share/mise/shims/node'),
    ...(process.env.PATH ?? '').split(':').filter(Boolean).map(directory => join(directory, 'node')),
    '/home/linuxbrew/.linuxbrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ];
  const node = candidates.find(candidate => existsSync(candidate));
  if (!node) throw new Error('node not found (tried mise shims, PATH, brew and /usr)');
  return node;
}

const node = findNode();

async function owners(...args) {
  const cli = ['--conditions=onionsoup-source', '--import', 'tsx', 'packages/owners/src/cli.ts', ...args,
    '--declarations', onionsoup.declarations, '--state', onionsoup.state];
  const { stdout } = await run(node, cli, { cwd: onionsoup.root, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** The decisions a person can record from the Desk, mapped to CLI commands. Nothing here advances work. */
const DECISIONS = {
  'approve-plan': ({ id }) => ['approve', id, '--no-advance'],
  'reject-plan': ({ id, reason }) => ['reject', id, '--reason', reason || 'rejected from the desk'],
  'approve-push': ({ id }) => ['approve-push', id, '--no-advance'],
  'approve-create': ({ id, withDelete }) => ['approve-create', id, ...(withDelete ? ['--with-delete'] : [])],
  'approve-delete': ({ id }) => ['approve-delete', id],
  'deny-request': ({ id, reason }) => ['deny-request', id, '--reason', reason || 'denied from the desk'],
};

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

function readBody(req) {
  return new Promise(resolveBody => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolveBody(body ? JSON.parse(body) : {}));
  });
}

async function handle(req, res, url) {
  if (url.pathname === '/health') return json(res, 200, { ok: true, onionsoup: onionsoup.root, node });
  if (url.pathname === '/state' && req.method === 'GET') {
    const args = ['desk-state'];
    for (const key of ['agent', 'directory', 'owner']) if (url.searchParams.get(key)) args.push(`--${key}`, url.searchParams.get(key));
    return json(res, 200, JSON.parse(await owners(...args)));
  }
  if (url.pathname === '/retract' && req.method === 'POST') {
    const { owner, note } = await readBody(req);
    await owners('retract', owner, '--note', note);
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/decide' && req.method === 'POST') {
    const body = await readBody(req);
    const command = DECISIONS[body.action];
    if (!command) return json(res, 400, { error: `unknown decision: ${body.action}` });
    return json(res, 200, { ok: true, output: (await owners(...command(body))).trim() });
  }
  return json(res, 404, { error: 'not-found' });
}

http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'unauthorized' });
  handle(req, res, new URL(req.url ?? '/', 'http://127.0.0.1')).catch(error => {
    const message = (error.stderr || error.message || String(error)).toString().trim().split('\n').slice(-3).join(' ');
    json(res, 500, { error: message });
  });
}).listen(port, '127.0.0.1');
