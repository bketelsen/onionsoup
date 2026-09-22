import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import { Agent } from 'undici';
import { z } from 'zod';
import type { ModelRef } from './declarations.ts';
import { freePort, spawnSandboxed, stopSandboxed } from './sandbox.ts';

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

const IMPLEMENTER_BASH: Record<string, 'allow' | 'deny'> = {
  ...READ_ONLY_BASH,
  'go build*': 'allow',
  'go fmt*': 'allow',
  'gofmt *': 'allow',
  'go mod tidy*': 'allow',
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
    prompt: 'You are a freelance implementer hired to carry out one approved plan in this working tree. Stay inside the plan. Do not commit.',
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

const AGENT_CONFIG = {
  agent: Object.fromEntries(Object.entries(ROLE_AGENTS).map(([role, definition]) => [`onionsoup-${role}`, { mode: 'primary', ...definition }])),
};

interface SandboxedServer {
  url: string;
  close: () => void;
}

/** One opencode server per hire, inside a sandbox shaped for the role. */
async function startServer(role: Role, directory: string): Promise<SandboxedServer> {
  const port = await freePort();
  const child = spawnSandboxed('opencode', ['serve', '--hostname=127.0.0.1', `--port=${port}`], {
    cwd: directory,
    writable: ROLE_WRITES[role](directory),
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(AGENT_CONFIG) },
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
    const server = await startServer(request.role, request.directory);
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
      const reply = await client.session.prompt({
        sessionID,
        agent: `onionsoup-${request.role}`,
        model: { providerID: providerID!, modelID: rest.join('/') },
        format: { type: 'json_schema', schema: z.toJSONSchema(request.schema) as Record<string, unknown>, retryCount: 2 },
        parts: [{ type: 'text', text: request.brief }],
      });
      const info = reply.data?.info as AssistantInfo | undefined;
      if (!info) throw new HireError(`no_assistant_reply: ${JSON.stringify(reply.error).slice(0, 300)}`, sessionID);
      if (info.error) throw new HireError(`${info.error.name ?? 'error'}: ${info.error.data?.message ?? ''}`.trim(), sessionID);
      const parsed = request.schema.safeParse(info.structured);
      if (!parsed.success) throw new HireError(`deliverable_invalid: ${parsed.error.message.slice(0, 500)}`, sessionID);
      return { value: parsed.data, sessionID, cost: info.cost ?? 0, startedAt, finishedAt: new Date().toISOString() };
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
    }
  }
}

export class HireError extends Error {
  constructor(message: string, readonly sessionID: string) {
    super(message);
  }
}
