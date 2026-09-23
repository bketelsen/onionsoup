import { execFile } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import { Agent } from 'undici';
import { z } from 'zod';
import type { ModelRef } from './declarations.ts';
import { freePort, spawnSandboxed, stopSandboxed } from './sandbox.ts';

const run = promisify(execFile);

export const HIRE_LIMITS = { heartbeatMs: 30_000, timeoutMs: 20 * 60_000, serverStartMs: 30_000 };

/** A hire can run far past undici's default 300 s header timeout; our own deadline aborts the session instead. */
const untimedAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const untimedFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  fetch(input, { ...init, dispatcher: untimedAgent } as RequestInit)) as typeof fetch;

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
export type Role = 'owner' | 'planner' | 'implementer' | 'reviewer';

const READ_ONLY_BASH: Record<string, 'allow' | 'deny'> = {
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

function rolePermission(bash: Record<string, 'allow' | 'deny'>, edit: 'allow' | 'deny') {
  return { edit, bash, webfetch: 'deny', websearch: 'deny', external_directory: 'deny', question: 'deny', task: 'deny', doom_loop: 'deny' };
}

const ROLE_AGENTS: Record<Role, { prompt: string; permission: ReturnType<typeof rolePermission> }> = {
  owner: {
    prompt: 'You are the owner of one software domain: its project manager. You know it through your notebook and by reading it. You never edit files.',
    permission: rolePermission(READ_ONLY_BASH, 'deny'),
  },
  planner: {
    prompt: 'You are a freelance planner hired for one piece of work. You read the code and write an implementation plan. You never edit files.',
    permission: rolePermission(READ_ONLY_BASH, 'deny'),
  },
  implementer: {
    prompt: 'You are a freelance implementer hired to carry out one approved plan in this working tree. Stay inside the plan. You may run any command the repository needs (install dependencies, build, test) inside your sandbox; only this working tree and caches are writable. Do not commit, push, use gh or sudo: the runtime lands your work after review.',
    permission: rolePermission(IMPLEMENTER_BASH, 'allow'),
  },
  reviewer: {
    prompt: 'You are a freelance code reviewer from a different model family than the implementer. Review the change against its plan. You never edit files.',
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
  planner: () => [],
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

function agentConfig(worktree: string, directory: string, notesFile: string | undefined, extra: Record<string, string> = {}) {
  return {
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
    const [providerID, ...rest] = request.model.split('/');
    const startedAt = new Date().toISOString();
    const session = await client.session.create({ title: request.title });
    const sessionID = session.data?.id;
    if (!sessionID) throw new Error(`session_create_failed: ${JSON.stringify(session.error)}`);
    const heartbeat = setInterval(() => log(`  … ${request.title}: ${request.model} working ${elapsedSeconds(startedAt)}s`), HIRE_LIMITS.heartbeatMs);
    const deadline = setTimeout(() => void client.session.abort({ sessionID }), HIRE_LIMITS.timeoutMs);
    try {
      // Synchronous on purpose: opencode 1.18.32 cannot list a session's messages once a prompt carried
      // a json_schema format ("Expected OutputFormatJsonSchema"), so the reply must come from this call.
      const prompt = async (text: string) => {
        const reply = await client.session.prompt({
          sessionID,
          agent: `onionsoup-${request.role}`,
          model: { providerID: providerID!, modelID: rest.join('/') },
          format: { type: 'json_schema', schema: z.toJSONSchema(request.schema) as Record<string, unknown>, retryCount: 2 },
          parts: [{ type: 'text', text }],
        });
        const info = reply.data?.info as AssistantInfo | undefined;
        if (!info) throw new HireError(`no_assistant_reply: ${JSON.stringify(reply.error).slice(0, 300)}`, sessionID);
        if (info.error) throw new HireError(`${info.error.name ?? 'error'}: ${info.error.data?.message ?? ''}`.trim(), sessionID);
        return info;
      };
      const first = await prompt(request.notesFile ? `${request.brief}\n\n${notesInstruction(request.notesFile)}` : request.brief);
      let cost = first.cost ?? 0;
      let parsed = parseDeliverable(request.schema, first.structured);
      if (!parsed.success) {
        // The work is done; only the shape is wrong. Ask once, in the same session, for the corrected deliverable.
        log(`  … ${request.title}: deliverable did not match its schema; asking ${request.model} to resend it`);
        const second = await prompt(resendInstruction(parsed.error));
        cost += second.cost ?? 0;
        parsed = parseDeliverable(request.schema, second.structured);
        if (!parsed.success) throw new HireError(`deliverable_invalid: ${parsed.error.message.slice(0, 500)}`, sessionID, second.structured ?? first.structured);
      }
      return { value: parsed.data, sessionID, cost, startedAt, finishedAt: new Date().toISOString() };
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
    }
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
  return `Your structured output did not match the required schema:\n${z.prettifyError(error)}\n\nSend the complete structured output again with these problems corrected. Lists must be JSON arrays (not strings containing JSON), and every required field must be present. Do not redo the work.`;
}
