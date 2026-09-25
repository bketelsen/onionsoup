import { execFile } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import { Agent } from 'undici';
import { z } from 'zod';
import type { ModelRef } from './declarations.ts';
import { freePort, spawnSandboxed, stopSandboxed } from './sandbox.ts';

const run = promisify(execFile);

export const HIRE_LIMITS = { heartbeatMs: 30_000, timeoutMs: 20 * 60_000, serverStartMs: 30_000, permissionPollMs: 2_000 };

/**
 * The onionsoup plugin, as a file:// URL sitting next to this module: sibling `plugin.ts` running from
 * source, sibling `plugin.js` running from the compiled dist build. The host's global opencode config is
 * masked inside the sandbox, so a sandboxed server can no longer find the plugin there; it is loaded
 * explicitly instead.
 */
export const PLUGIN_URL = new URL(`plugin.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url).href;

/**
 * A hire can run far past the runtime's default 300 s fetch timeout; our own deadline aborts the session instead.
 * Node honours undici's `dispatcher`; Bun, which runs this module inside opencode's plugin host, ignores it and
 * needs its own `timeout: false`. Each runtime ignores the other's option.
 */
const untimedAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const untimedFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  fetch(input, { ...init, dispatcher: untimedAgent, timeout: false } as RequestInit)) as typeof fetch;

/** An Error serialises to `{}`; say what went wrong instead. */
export function describeReplyError(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return JSON.stringify(error ?? null).slice(0, 300);
}

function elapsedSeconds(startedAt: string) {
  return Math.round((Date.now() - Date.parse(startedAt)) / 1000);
}

function log(message: string) {
  process.stderr.write(`${message}\n`);
}

/**
 * opencode agents, one per role. Nothing asks: a headless "ask" waits forever. These rules are a
 * convenience layer only; the sandbox (read-only root, memory cap) is the boundary.
 */
export type Role = 'owner' | 'implementer' | 'reviewer';

export const READ_ONLY_BASH: Record<string, 'allow' | 'deny'> = {
  '*': 'deny',
  'ls*': 'allow',
  'grep *': 'allow',
  'rg *': 'allow',
  'git log*': 'allow',
  'git show*': 'allow',
  'git diff*': 'allow',
  'git status*': 'allow',
  'go doc*': 'allow',
  'go vet*': 'allow',
  'go test*': 'allow',
  'go list*': 'allow',
};

/**
 * The implementer runs whatever its repository needs (npm, python, make, go…): the sandbox is the boundary (read-only
 * root, only the worktree and caches writable, memory-capped, no host-only credentials). The sandbox can still read
 * SSH keys and the gh login, so publishing stays with host code: no commits, pushes, gh or sudo. Last match wins.
 */
export const IMPLEMENTER_BASH: Record<string, 'allow' | 'deny'> = {
  '*': 'allow',
  'git commit*': 'deny',
  'git * commit*': 'deny',
  'git push*': 'deny',
  'git * push*': 'deny',
  'gh': 'deny',
  'gh *': 'deny',
  'sudo': 'deny',
  'sudo *': 'deny',
};

/**
 * opencode asks before reading env-named files (`*.env`, `*.env.*`), and nobody can answer inside a hire, so a review
 * of an Ansible `coder.env.j2` template waited until its deadline. A hire's tree holds the repository's tracked files
 * and what the hire generated, and the sandbox is the boundary, so hires read them. opencode appends agent rules
 * after its defaults and the last match wins, so these patterns override its `ask` for the same names.
 */
const HIRE_READ = { '*': 'allow', '*.env': 'allow', '*.env.*': 'allow' } as const;

function rolePermission(bash: Record<string, 'allow' | 'deny'>, edit: 'allow' | 'deny') {
  return {
    read: HIRE_READ, edit, bash,
    webfetch: 'deny', websearch: 'deny', external_directory: 'deny', question: 'deny', task: 'deny', doom_loop: 'deny',
  };
}

const ROLE_AGENTS: Record<Role, { prompt: string; permission: ReturnType<typeof rolePermission> }> = {
  owner: {
    prompt: 'You are the owner of one software domain: its project manager. You know it through your notebook and by reading it. You never edit files.',
    permission: rolePermission(READ_ONLY_BASH, 'deny'),
  },
  implementer: {
    prompt: 'You are a freelance implementer hired for one task in this working tree. Stay inside the task. You may run any command the repository needs (install dependencies, build, test) inside your sandbox; only this working tree and caches are writable. Do not commit, push, use gh or sudo: the runtime lands your work after review.',
    permission: rolePermission(IMPLEMENTER_BASH, 'allow'),
  },
  reviewer: {
    prompt: 'You are a freelance code reviewer from a different model family than the author. Review the change against what it claims to do. You never edit files.',
    permission: rolePermission(READ_ONLY_BASH, 'deny'),
  },
};

export interface HireRequest<T> {
  role: Role;
  model: ModelRef;
  directory: string;
  title: string;
  brief: string;
  schema: z.ZodType<T>;
  /** A file the hire may append findings to while it works; read back even if the hire fails. */
  notesFile?: string;
  /** Extra permission rules for this hire only (e.g. web fetch to read release notes). */
  extraPermission?: Record<string, string>;
}

export interface HireResult<T> {
  value: T;
  sessionID: string;
  cost: number;
  startedAt: string;
  finishedAt: string;
}

interface AssistantInfo {
  role: string;
  structured?: unknown;
  error?: { name?: string; data?: { message?: string } };
  cost?: number;
}

/** Which paths a role may write inside its sandbox. Only the implementer writes its working tree. */
const ROLE_WRITES: Record<Role, (directory: string) => string[]> = {
  owner: () => [],
  implementer: directory => [directory],
  reviewer: () => [],
};

/** Carve one writable notes file out of an otherwise read-only role. Later rules win in opencode. */
function withNotes(permission: ReturnType<typeof rolePermission>, worktree: string, directory: string, notesFile: string | undefined) {
  if (!notesFile) return permission;
  // opencode matches edit rules against the path relative to the enclosing git worktree, which may be a
  // parent repository of the session directory (a gitignored folder is still inside it), or "/" outside git.
  const keys = new Set([relative(worktree, notesFile), relative(directory, notesFile), relative('/', notesFile)]);
  return {
    ...permission,
    edit: { '*': permission.edit, ...Object.fromEntries([...keys].map(key => [key, 'allow'])) },
    external_directory: { '*': 'deny', [join(dirname(notesFile), '*')]: 'allow' },
  };
}

/** The git worktree opencode will use for a session directory: the enclosing repository's root, or "/". */
async function worktreeOf(directory: string) {
  try {
    const { stdout } = await run('git', ['-C', directory, 'rev-parse', '--show-toplevel']);
    return stdout.trim() || '/';
  } catch {
    return '/';
  }
}

/** Exported for tests: the per-hire opencode config, so the explicit plugin load can be checked directly. */
export function agentConfig(worktree: string, directory: string, notesFile: string | undefined, extra: Record<string, string> = {}) {
  return {
    plugin: [PLUGIN_URL],
    agent: Object.fromEntries(Object.entries(ROLE_AGENTS).map(([role, definition]) => [
      `onionsoup-${role}`,
      { mode: 'primary', prompt: definition.prompt, permission: { ...withNotes(definition.permission, worktree, directory, notesFile), ...extra } },
    ])),
  };
}

function notesInstruction(notesFile: string) {
  return `Findings file: ${notesFile}
The moment you discover something a future worker must not lose (a bug, a surprising behavior, a risky
input, a convention), append one line to that file with the edit tool. Do not wait until the end: if this
session dies, only what is in that file survives. It is the only file you may write.`;
}

interface SandboxedServer {
  url: string;
  close: () => void;
}

/** One opencode server per hire, inside a sandbox shaped for the role. */
async function startServer(role: Role, directory: string, notesFile: string | undefined, extra?: Record<string, string>): Promise<SandboxedServer> {
  const port = await freePort();
  const notesWritable = notesFile ? [dirname(notesFile)] : [];
  const child = spawnSandboxed('opencode', ['serve', '--hostname=127.0.0.1', `--port=${port}`], {
    cwd: directory,
    writable: [...ROLE_WRITES[role](directory), ...notesWritable],
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(agentConfig(await worktreeOf(directory), directory, notesFile, extra)) },
  });
  const url = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`server_start_timeout: ${output.slice(-500)}`)), HIRE_LIMITS.serverStartMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/opencode server listening on\s+(https?:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`server_exited: ${code} ${output.slice(-500)}`));
    });
  });
  return { url, close: () => stopSandboxed(child) };
}

type HireClient = ReturnType<typeof createOpencodeClient>;

/**
 * Any permission question a hire still raises has nobody to answer it: reject it at once with a reason the model
 * can read, so it works without it or reports the need, instead of waiting silently until the hire's deadline.
 */
export async function rejectPendingPermissions(client: Pick<HireClient, 'permission'>, directory: string, title: string) {
  const pending = (await client.permission.list({ directory })).data ?? [];
  for (const request of pending) {
    const asked = `${request.permission} ${request.patterns.join(', ')}`;
    const message = `permission_needs_person: ${asked}. Nobody can approve this inside a hire; work without it, or say in your deliverable that you needed it.`;
    await client.permission.reply({ directory, requestID: request.id, reply: 'reject', message });
    log(`  … ${title}: rejected permission ${asked}`);
  }
}

export class Freelancers {
  static async start() {
    return new Freelancers();
  }

  close() {}

  async hire<T>(request: HireRequest<T>): Promise<HireResult<T>> {
    const server = await startServer(request.role, request.directory, request.notesFile, request.extraPermission);
    try {
      return await this.hireOn(server.url, request);
    } finally {
      server.close();
    }
  }

  private async hireOn<T>(url: string, request: HireRequest<T>): Promise<HireResult<T>> {
    const client = createOpencodeClient({ baseUrl: url, directory: request.directory, fetch: untimedFetch });
    return hireWithFallback(client, request);
  }
}

/**
 * opencode asks for structured output by forcing a tool call, and some models refuse forced tool choice (Copilot's
 * claude-opus-5.5: anomalyco/opencode#46735). The refusal comes before any work, so such a hire starts again in a
 * new session in text mode: the brief ends with the JSON Schema and the reply's JSON is parsed here. The model is
 * remembered for this process, so its later hires start in text mode.
 */
const FORCED_TOOL_REFUSED = /tool_choice: type "tool" and "any" are not supported/;
const textModeModels = new Set<string>();

export type DeliveryMode = 'structured' | 'text';

export async function hireWithFallback<T>(client: HireSessionClient, request: HireRequest<T>): Promise<HireResult<T>> {
  const mode: DeliveryMode = textModeModels.has(request.model) ? 'text' : 'structured';
  try {
    return await runHire(client, request, mode);
  } catch (error) {
    if (mode !== 'structured' || !(error instanceof HireError) || !FORCED_TOOL_REFUSED.test(error.message)) throw error;
    textModeModels.add(request.model);
    log(`  … ${request.title}: ${request.model} refuses forced tool choice; asking for the JSON in its reply instead`);
    return runHire(client, request, 'text');
  }
}

/** The parts of the opencode client a hire uses, so tests can script it. */
export type HireSessionClient = Pick<HireClient, 'session' | 'permission'>;

interface ReplyData { info?: AssistantInfo; parts?: { type: string; text?: string }[] }

interface DeliveryModeSpec {
  format: (schema: Record<string, unknown>) => Record<string, unknown> | undefined;
  instruction: (schema: Record<string, unknown>) => string;
  deliverable: (reply: ReplyData) => unknown;
}

const DELIVERY_MODES: Record<DeliveryMode, DeliveryModeSpec> = {
  structured: {
    format: schema => ({ type: 'json_schema', schema, retryCount: 2 }),
    instruction: () => '',
    deliverable: reply => reply.info?.structured,
  },
  text: {
    format: () => undefined,
    instruction: schema => `\n\nWhen you are done, your final reply must be only one JSON object that matches this JSON Schema, with no other text:\n${JSON.stringify(schema)}`,
    deliverable: reply => jsonFromText((reply.parts ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('')),
  },
};

/** The JSON object in a reply: a fenced json block if there is one, else the outermost braces; the text if neither parses. */
export function jsonFromText(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].at(-1)?.[1];
  const braces = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  for (const candidate of [fenced, braces]) {
    if (!candidate?.trim()) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Not JSON: try the next candidate, and let the schema reject the text if none parses.
    }
  }
  return text;
}

/** One hire session in one delivery mode: the brief, then at most one request to resend a malformed deliverable. */
export async function runHire<T>(client: HireSessionClient, request: HireRequest<T>, mode: DeliveryMode): Promise<HireResult<T>> {
  const [providerID, ...rest] = request.model.split('/');
  const spec = DELIVERY_MODES[mode];
  const schema = z.toJSONSchema(request.schema) as Record<string, unknown>;
  const startedAt = new Date().toISOString();
  const session = await client.session.create({ title: request.title });
  const sessionID = session.data?.id;
  if (!sessionID) throw new Error(`session_create_failed: ${JSON.stringify(session.error)}`);
  const heartbeat = setInterval(() => log(`  … ${request.title}: ${request.model} working ${elapsedSeconds(startedAt)}s`), HIRE_LIMITS.heartbeatMs);
  const deadline = setTimeout(() => void client.session.abort({ sessionID }), HIRE_LIMITS.timeoutMs);
  // A failed poll is retried on the next interval; the hire's own deadline still bounds it.
  const refuser = setInterval(() => void rejectPendingPermissions(client, request.directory, request.title).catch(() => undefined), HIRE_LIMITS.permissionPollMs);
  try {
    // Synchronous on purpose: opencode 1.18.32 cannot list a session's messages once a prompt carried
    // a json_schema format ("Expected OutputFormatJsonSchema"), so the reply must come from this call.
    const prompt = async (text: string) => {
      const format = spec.format(schema);
      const reply = await client.session.prompt({
        sessionID,
        agent: `onionsoup-${request.role}`,
        model: { providerID: providerID!, modelID: rest.join('/') },
        ...(format ? { format } : {}),
        parts: [{ type: 'text', text }],
      } as Parameters<HireClient['session']['prompt']>[0]);
      const data = reply.data as ReplyData | undefined;
      const info = data?.info;
      if (!info) throw new HireError(`no_assistant_reply: ${describeReplyError(reply.error)}`, sessionID);
      if (info.error) throw new HireError(`${info.error.name ?? 'error'}: ${info.error.data?.message ?? ''}`.trim(), sessionID);
      return { info, deliverable: spec.deliverable(data) };
    };
    const brief = request.notesFile ? `${request.brief}\n\n${notesInstruction(request.notesFile)}` : request.brief;
    const first = await prompt(`${brief}${spec.instruction(schema)}`);
    let cost = first.info.cost ?? 0;
    let parsed = parseDeliverable(request.schema, first.deliverable);
    if (!parsed.success) {
      // The work is done; only the shape is wrong. Ask once, in the same session, for the corrected deliverable.
      log(`  … ${request.title}: deliverable did not match its schema; asking ${request.model} to resend it`);
      const second = await prompt(`${resendInstruction(parsed.error)}${spec.instruction(schema)}`);
      cost += second.info.cost ?? 0;
      parsed = parseDeliverable(request.schema, second.deliverable);
      if (!parsed.success) throw new HireError(`deliverable_invalid: ${parsed.error.message.slice(0, 500)}`, sessionID, second.deliverable ?? first.deliverable);
    }
    return { value: parsed.data, sessionID, cost, startedAt, finishedAt: new Date().toISOString() };
  } finally {
    clearInterval(heartbeat);
    clearInterval(refuser);
    clearTimeout(deadline);
  }
}

export class HireError extends Error {
  constructor(message: string, readonly sessionID: string, readonly deliverable?: unknown) {
    super(message);
  }
}

/**
 * Models sometimes send a list or object field as a string holding its JSON ("[\"a\", \"b\"]"). Where the schema
 * rejected a string for a list or object, parse that string back; nothing the schema accepted is touched.
 */
export function repairDeliverable(value: unknown, issues: readonly z.core.$ZodIssue[]): unknown {
  if (!value || typeof value !== 'object') return value;
  const repaired = structuredClone(value) as Record<PropertyKey, unknown>;
  for (const issue of issues) {
    if (issue.code !== 'invalid_type' || !['array', 'object'].includes(issue.expected) || issue.path.length === 0) continue;
    const parent = issue.path.slice(0, -1).reduce<unknown>((node, key) => (node as Record<PropertyKey, unknown> | undefined)?.[key as PropertyKey], repaired) as Record<PropertyKey, unknown> | undefined;
    const key = issue.path.at(-1) as PropertyKey;
    const field = parent?.[key];
    if (typeof field !== 'string') continue;
    try {
      const decoded: unknown = JSON.parse(field);
      if ((issue.expected === 'array') === Array.isArray(decoded) && decoded !== null && typeof decoded === 'object') parent![key] = decoded;
    } catch {
      // Not JSON: leave it for the schema to reject.
    }
  }
  return repaired;
}

export function parseDeliverable<T>(schema: z.ZodType<T>, value: unknown) {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed : schema.safeParse(repairDeliverable(value, parsed.error.issues));
}

function resendInstruction(error: z.ZodError) {
  return `Your deliverable did not match the required schema:\n${z.prettifyError(error)}\n\nSend the complete deliverable again with these problems corrected. Lists must be JSON arrays (not strings containing JSON), and every required field must be present. Do not redo the work.`;
}
