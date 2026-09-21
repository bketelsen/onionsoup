import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, realpath, rm, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { atomicJson } from '@onionsoup/runtime/storage';
import { HostError } from './errors.ts';
import { Recipe, validateRecipe, inferParams, paramSchema, resolveInput, type StepOutcome } from './recipes.ts';
export { HostError } from './errors.ts';
export { Recipe, Step, Binding, bindings, inferParams, paramSchema, type StepOutcome } from './recipes.ts';

/** Defaults. Every one of these is a knob, not a contract. */
export const HOST_LIMITS = {
  inputBytes: 32768,
  resultBytes: 8 * 1024 * 1024,
  ledgerBytes: 32 * 1024 * 1024,
  jobs: 5000,
  queue: 64,
  events: 10,
} as const;

const Id = z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/);
const Status = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
export type JobStatus = z.infer<typeof Status>;

export const JobRequest = z.object({
  capability: Id,
  input: z.json(),
  idempotencyKey: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),
  correlationId: z.uuid().optional(),
  parentJobId: z.uuid().optional(),
}).strict();
export type JobRequest = z.infer<typeof JobRequest>;

const Event = z.object({ sequence: z.number().int().positive(), at: z.iso.datetime(), status: Status }).strict();

const Job = z.object({
  schemaVersion: z.literal(1),
  jobId: z.uuid(),
  owner: Id,
  capability: Id,
  version: Id,
  binding: z.string().length(64),
  input: z.json(),
  inputHash: z.string().length(64),
  idempotencyKey: JobRequest.shape.idempotencyKey,
  correlationId: z.uuid().optional(),
  parentJobId: z.uuid().optional(),
  createdAt: z.iso.datetime(),
  status: Status,
  events: z.array(Event).min(1).max(HOST_LIMITS.events),
  resultHash: z.string().length(64).optional(),
  error: z.string().max(2000).optional(),
}).strict();
export type Job = z.infer<typeof Job>;
export type JobView = Job & { result?: unknown };

export const Invoker = z.object({
  id: Id,
  /** Absent for invokers that only reach the host through the same-origin web path. */
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  capabilities: z.array(Id).min(1).max(100),
  /** Lifetime admission cap. Absent means unlimited. */
  maxJobs: z.number().int().min(1).optional(),
}).strict();
export type Invoker = z.infer<typeof Invoker>;

export type CapabilityContext = {
  directory: string;
  signal: AbortSignal;
  job: Job;
  dependency: (id: string) => Promise<JobView>;
};

export type Capability = {
  id: string;
  version: string;
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  validateOutput?: (value: unknown) => unknown;
  metadata: unknown;
  effects: string[];
  timeoutMs: number;
  execute: (input: any, context: CapabilityContext) => Promise<unknown>;
};

const canonical = (value: any): any =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value;

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const stamp = () => new Date().toISOString();

async function boundedJson(root: string, relative: string, limit: number) {
  const expected = join(await realpath(root), relative);
  const actual = await realpath(join(root, relative));
  if (actual !== expected) throw new HostError('invalid_artifact');
  const file = await open(actual, 'r');
  try {
    if (!(await file.stat()).isFile()) throw new HostError('invalid_artifact');
    const buffer = Buffer.alloc(limit + 1);
    let n = 0;
    while (n < buffer.length) {
      const { bytesRead } = await file.read(buffer, n, buffer.length - n, n);
      if (!bytesRead) break;
      n += bytesRead;
    }
    if (n > limit) throw new HostError('artifact_too_large');
    return JSON.parse(buffer.subarray(0, n).toString());
  } finally {
    await file.close();
  }
}

export type JobListener = (job: Job) => void;

export type HostOptions = {
  directory: string;
  /** Operator configuration, hashed into each job for provenance. */
  binding: unknown;
  capabilities: Capability[];
  invokers: Invoker[];
  persist?: typeof atomicJson;
  limits?: Partial<typeof HOST_LIMITS>;
  /** Recipes available at launch. Saved recipes under <directory>/recipes are loaded too. */
  recipes?: unknown[];
};

export async function openJobHost(options: HostOptions) {
  const limits = { ...HOST_LIMITS, ...options.limits };
  const root = resolve(options.directory);
  const capabilities = new Map(options.capabilities.map((c) => [Id.parse(c.id), c]));
  const invokers = z.array(Invoker).min(1).max(100).parse(options.invokers);
  const hashes = invokers.map((i) => i.tokenHash).filter(Boolean);
  if (capabilities.size !== options.capabilities.length) throw new HostError('duplicate_registration');
  if (new Set(invokers.map((i) => i.id)).size !== invokers.length) throw new HostError('duplicate_registration');
  if (new Set(hashes).size !== hashes.length) throw new HostError('duplicate_registration');
  for (const c of capabilities.values()) {
    Id.parse(c.version);
    z.number().int().min(1).max(600000).parse(c.timeoutMs);
  }
  if (invokers.some((i) => i.capabilities.some((c) => !capabilities.has(c)))) throw new HostError('unknown_grant');

  const describe = (c: Capability) => ({
    id: c.id,
    version: c.version,
    description: c.description,
    inputSchema: z.toJSONSchema(c.input),
    outputSchema: z.toJSONSchema(c.output),
    metadata: c.metadata,
    effects: c.effects,
    timeoutMs: c.timeoutMs,
  });
  const binding = digest({ protocol: 'job-host-v1', configuration: options.binding, capabilities: [...capabilities.values()].map(describe) });
  const described = new Map([...capabilities.values()].map((c) => [c.id, describe(c)]));
  const recipes = new Map<string, Recipe>();
  const recipeDir = join(resolve(options.directory), 'recipes');
  const RECIPE_PREFIX = 'recipe.';
  const recipeOf = (capabilityId: string) => (capabilityId.startsWith(RECIPE_PREFIX) ? recipes.get(capabilityId.slice(RECIPE_PREFIX.length)) : undefined);
  const describeRecipe = (r: Recipe) => {
    const params = inferParams(r, described);
    const steps = r.steps.map((s) => capabilities.get(s.capability)!);
    return {
      id: RECIPE_PREFIX + r.id,
      version: 'v1',
      description: r.description || r.title,
      inputSchema: paramSchema(params),
      outputSchema: { type: 'object', properties: { recipe: { type: 'string' }, params: { type: 'object' }, steps: { type: 'array' } } },
      metadata: { kind: 'recipe', recipe: r, params },
      effects: [...new Set(steps.flatMap((c) => c.effects))],
      timeoutMs: steps.reduce((total, c) => total + c.timeoutMs, 0),
    };
  };
  const recipeAllowed = (r: Recipe, invoker: Invoker) => r.steps.every((s) => invoker.capabilities.includes(s.capability));
  const Ledger = z.object({ schemaVersion: z.literal(1), jobs: z.array(Job).max(limits.jobs) }).strict();

  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, '.host-lock');
  await mkdir(lock, { mode: 0o700 });

  let ledger: z.infer<typeof Ledger> = { schemaVersion: 1, jobs: [] };
  let broken = false;
  let stopped = false;
  let closed = false;
  let serial: Promise<unknown> = Promise.resolve();
  let draining: Promise<void> | undefined;
  const controllers = new Map<string, AbortController>();
  const listeners = new Set<JobListener>();

  const exclusive = <T>(fn: () => Promise<T>) => {
    const p = serial.then(fn);
    serial = p.catch(() => {});
    return p;
  };
  const save = async () => {
    try {
      const checked = Ledger.parse(ledger);
      if (Buffer.byteLength(JSON.stringify(checked)) > limits.ledgerBytes) throw Error('ledger too large');
      await (options.persist ?? atomicJson)(join(root, 'ledger.json'), checked);
    } catch {
      broken = true;
      for (const c of controllers.values()) c.abort();
      throw new HostError('persistence_failed', 503);
    }
  };
  const notify = (job: Job) => {
    const snapshot = structuredClone(job);
    for (const listener of listeners) {
      try { listener(snapshot); } catch { /* listener errors never affect the host */ }
    }
  };
  const transition = (job: Job, status: JobStatus, error?: string) => {
    job.status = status;
    if (error) job.error = error.slice(0, 2000);
    job.events.push({ sequence: job.events.length + 1, at: stamp(), status });
    notify(job);
  };

  try {
    await atomicJson(join(lock, 'owner.json'), { pid: process.pid, at: stamp() });
    try {
      const raw = await boundedJson(root, 'ledger.json', limits.ledgerBytes);
      ledger = Ledger.parse(raw);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const ids = new Set<string>();
    for (const j of ledger.jobs) {
      if (ids.has(j.jobId)) throw new HostError('invalid_ledger');
      ids.add(j.jobId);
      if (j.status === 'running' || j.status === 'queued') transition(j, 'interrupted', 'Host restarted before the job finished');
    }
    await save();
    for (const raw of options.recipes ?? []) { const r = validateRecipe(raw, described); recipes.set(r.id, r); }
    await mkdir(recipeDir, { recursive: true, mode: 0o700 });
    for (const file of (await readdir(recipeDir)).filter((f) => f.endsWith('.json')).sort()) {
      try { const r = validateRecipe(await boundedJson(recipeDir, file, 256 * 1024), described); recipes.set(r.id, r); }
      catch { /* an invalid saved recipe is skipped, not fatal */ }
    }
  } catch (e) {
    await rm(lock, { recursive: true, force: true });
    throw e;
  }

  function recipeParams(recipe: Recipe, raw: unknown) {
    const params = inferParams(recipe, described);
    const input = z.record(z.string(), z.json()).parse(raw ?? {});
    for (const name of Object.keys(params)) if (!(name in input)) throw new HostError(`missing_param:${name}`);
    for (const name of Object.keys(input)) if (!(name in params)) throw new HostError(`unknown_param:${name}`);
    return input;
  }
  const owner = (id: string) => {
    const p = invokers.find((i) => i.id === id);
    if (!p) throw new HostError('unauthorized', 401);
    return p;
  };
  const ownedJobs = (principal: string) => ledger.jobs.filter((j) => j.owner === principal);

  async function inspect(principal: string, id: string): Promise<JobView> {
    z.uuid().parse(id);
    owner(principal);
    const job = ledger.jobs.find((j) => j.jobId === id && j.owner === principal);
    if (!job) throw new HostError('job_not_found', 404);
    const view: JobView = structuredClone(job);
    if (view.status !== 'completed') return view;
    const result = await boundedJson(root, join(id, 'result.json'), limits.resultBytes);
    if (digest(result) !== view.resultHash) throw new HostError('result_mismatch', 409);
    const c = capabilities.get(job.capability);
    if (!c) return { ...view, result };
    const parsed = c.output.parse(result);
    return { ...view, result: c.validateOutput ? c.validateOutput(parsed) : parsed };
  }

  async function runOne(job: Job) {
    const c = capabilities.get(job.capability)!;
    const controller = controllers.get(job.jobId)!;
    if (stopped) controller.abort();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(c.timeoutMs)]);
    let status: JobStatus = 'failed';
    let error: string | undefined;
    let resultHash: string | undefined;
    try {
      signal.throwIfAborted();
      const directory = join(root, job.jobId);
      await mkdir(directory, { mode: 0o700 });
      const context: CapabilityContext = {
        directory,
        signal,
        job: structuredClone(job),
        dependency: async (id) => {
          const dependency = await inspect(job.owner, id);
          if (dependency.status !== 'completed') throw new HostError('dependency_unavailable');
          return dependency;
        },
      };
      const produced = await c.execute(structuredClone(job.input), context);
      let result = c.output.parse(JSON.parse(JSON.stringify(produced)));
      if (c.validateOutput) result = c.validateOutput(result);
      signal.throwIfAborted();
      z.json().parse(result);
      if (Buffer.byteLength(JSON.stringify(result)) > limits.resultBytes) throw new HostError('result_too_large');
      try {
        await (options.persist ?? atomicJson)(join(directory, 'result.json'), result);
      } catch {
        broken = true;
        throw new HostError('persistence_failed');
      }
      resultHash = digest(result);
      status = 'completed';
    } catch (e) {
      status = signal.aborted ? 'cancelled' : 'failed';
      error = e instanceof HostError ? e.code : e instanceof Error ? e.message : 'failed';
      if (signal.aborted && controller.signal.aborted === false) error = 'timeout';
    }
    controllers.delete(job.jobId);
    await exclusive(async () => {
      if (resultHash) job.resultHash = resultHash;
      transition(job, status, error);
      await save();
    });
  }

  const terminal = (status: JobStatus) => status !== 'queued' && status !== 'running';
  function waitFor(jobId: string, signal: AbortSignal): Promise<Job> {
    return new Promise((resolveWait, reject) => {
      const current = ledger.jobs.find((j) => j.jobId === jobId);
      if (!current) return reject(new HostError('job_not_found', 404));
      if (terminal(current.status)) return resolveWait(structuredClone(current));
      const listener: JobListener = (job) => { if (job.jobId === jobId && terminal(job.status)) { cleanup(); resolveWait(job); } };
      const onAbort = () => { cleanup(); reject(new HostError('cancelled')); };
      const cleanup = () => { listeners.delete(listener); signal.removeEventListener('abort', onAbort); };
      listeners.add(listener);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Recipes run outside the capability lane: each step is an ordinary child job, submitted in order. */
  async function runRecipe(parent: Job, recipe: Recipe) {
    const controller = new AbortController();
    controllers.set(parent.jobId, controller);
    const signal = controller.signal;
    const params = parent.input as Record<string, unknown>;
    const done = new Map<string, { jobId: string; result?: unknown }>();
    const outcomes: StepOutcome[] = [];
    let status: JobStatus = 'completed';
    let error: string | undefined;
    let current: string | undefined;
    const onAbort = () => { if (current) void host.cancel(parent.owner, current).catch(() => {}); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await mkdir(join(root, parent.jobId), { mode: 0o700 });
      for (const step of recipe.steps) {
        signal.throwIfAborted();
        const outcome: StepOutcome = { id: step.id, capability: step.capability, status: 'queued' };
        outcomes.push(outcome);
        let child: Job;
        try {
          const input = resolveInput(step.input, { params, jobs: done });
          const submitted = await host.submit(parent.owner, { capability: step.capability, input, idempotencyKey: `${parent.idempotencyKey}--${step.id}`.slice(0, 128), parentJobId: parent.jobId });
          outcome.jobId = submitted.jobId;
          current = submitted.jobId;
          child = await waitFor(submitted.jobId, signal);
          current = undefined;
        } catch (e) {
          outcome.status = 'failed';
          outcome.error = e instanceof HostError ? e.code : e instanceof Error ? e.message : 'failed';
          if (signal.aborted) throw e;
          if (!step.continueOnFailure) { status = 'failed'; error = `step ${step.id}: ${outcome.error}`; break; }
          continue;
        }
        outcome.status = child.status;
        outcome.error = child.error;
        if (child.status === 'completed') {
          const view = await inspect(parent.owner, child.jobId);
          done.set(step.id, { jobId: child.jobId, result: view.result });
        } else if (!step.continueOnFailure) {
          status = 'failed';
          error = `step ${step.id}: ${child.error ?? child.status}`;
          break;
        }
      }
    } catch (e) {
      status = signal.aborted ? 'cancelled' : 'failed';
      error = e instanceof HostError ? e.code : e instanceof Error ? e.message : 'failed';
    }
    signal.removeEventListener('abort', onAbort);
    let resultHash: string | undefined;
    if (status === 'completed') {
      const result = { recipe: recipe.id, params, steps: outcomes };
      try {
        await (options.persist ?? atomicJson)(join(root, parent.jobId, 'result.json'), result);
        resultHash = digest(result);
      } catch {
        broken = true;
        status = 'failed';
        error = 'persistence_failed';
      }
    }
    controllers.delete(parent.jobId);
    await exclusive(async () => {
      if (resultHash) parent.resultHash = resultHash;
      transition(parent, status, error ?? (outcomes.length ? undefined : 'no steps'));
      await save();
    });
  }

  function start() {
    if (draining || stopped || broken) return;
    draining = (async () => {
      while (!stopped && !broken) {
        const job = await exclusive(async () => {
          if (stopped || broken) return;
          const next = ledger.jobs.find((j) => j.status === 'queued');
          if (!next) return;
          controllers.set(next.jobId, new AbortController());
          transition(next, 'running');
          await save();
          return next;
        });
        if (!job) break;
        await runOne(job);
      }
    })()
      .catch(() => { broken = true; })
      .finally(() => {
        draining = undefined;
        if (!stopped && !broken && ledger.jobs.some((j) => j.status === 'queued')) start();
      });
  }

  type Host = ReturnType<typeof build>;
  let host: Host;
  function build() { return {
    binding,
    limits,
    recipeOf,
    authenticate(token: string) {
      const h = Buffer.from(tokenHash(token), 'hex');
      const found = invokers.find((i) => i.tokenHash && timingSafeEqual(h, Buffer.from(i.tokenHash, 'hex')));
      if (!found) throw new HostError('unauthorized', 401);
      return found.id;
    },
    hasInvoker(id: string) {
      return invokers.some((i) => i.id === id);
    },
    discover(principal: string) {
      const p = owner(principal);
      return {
        schemaVersion: 1,
        binding,
        invoker: p.id,
        remainingAdmissions: p.maxJobs === undefined ? null : p.maxJobs - ownedJobs(p.id).length,
        capabilities: [
          ...[...capabilities.values()].filter((c) => p.capabilities.includes(c.id)).map(describe),
          ...[...recipes.values()].filter((r) => recipeAllowed(r, p)).map(describeRecipe),
        ],
        limits,
        lifecycle: { automaticReplay: false, concurrency: 1 },
      };
    },
    listRecipes(principal: string) {
      const p = owner(principal);
      return [...recipes.values()].filter((r) => recipeAllowed(r, p)).map((r) => ({ ...r, paramSchema: inferParams(r, described) }));
    },
    async saveRecipe(principal: string, raw: unknown) {
      const p = owner(principal);
      const allowed = new Map([...described].filter(([id]) => p.capabilities.includes(id)));
      const recipe = validateRecipe(raw, allowed);
      await atomicJson(join(recipeDir, `${recipe.id}.json`), recipe);
      recipes.set(recipe.id, recipe);
      return { ...recipe, paramSchema: inferParams(recipe, described) };
    },
    async deleteRecipe(principal: string, id: string) {
      const p = owner(principal);
      const recipe = recipes.get(id);
      if (!recipe || !recipeAllowed(recipe, p)) throw new HostError('recipe_not_found', 404);
      recipes.delete(id);
      await unlink(join(recipeDir, `${id}.json`)).catch(() => {});
      return { id };
    },
    list(principal: string): Job[] {
      owner(principal);
      return ownedJobs(principal).map((j) => structuredClone(j)).reverse();
    },
    subscribe(principal: string, listener: JobListener) {
      owner(principal);
      const scoped: JobListener = (job) => { if (job.owner === principal) listener(job); };
      listeners.add(scoped);
      return () => { listeners.delete(scoped); };
    },
    async submit(principal: string, raw: unknown) {
      return exclusive(async () => {
        if (stopped || broken) throw new HostError('host_unavailable', 503);
        const p = owner(principal);
        const r = JobRequest.parse(raw);
        const recipe = recipeOf(r.capability);
        const c = capabilities.get(r.capability);
        if (recipe ? !recipeAllowed(recipe, p) : !c || !p.capabilities.includes(r.capability)) throw new HostError('capability_not_allowed', 403);
        const input = recipe ? recipeParams(recipe, r.input) : z.json().parse(c!.input.parse(r.input));
        if (Buffer.byteLength(JSON.stringify(input)) > limits.inputBytes) throw new HostError('input_too_large', 413);
        const prior = ledger.jobs.find((j) => j.owner === principal && j.idempotencyKey === r.idempotencyKey);
        if (prior) {
          const same = prior.capability === r.capability && prior.inputHash === digest(input)
            && prior.correlationId === r.correlationId && prior.parentJobId === r.parentJobId;
          if (!same) throw new HostError('idempotency_conflict', 409);
          return { jobId: prior.jobId, reused: true };
        }
        if (r.parentJobId) await inspect(principal, r.parentJobId);
        if (ledger.jobs.length >= limits.jobs) throw new HostError('admission_limit', 429);
        if (p.maxJobs !== undefined && ownedJobs(principal).length >= p.maxJobs) throw new HostError('admission_limit', 429);
        if (ledger.jobs.filter((j) => j.status === 'queued' || j.status === 'running').length >= limits.queue) throw new HostError('queue_full', 429);
        const job: Job = {
          schemaVersion: 1,
          jobId: randomUUID(),
          owner: principal,
          capability: r.capability,
          version: recipe ? 'v1' : c!.version,
          binding,
          input,
          inputHash: digest(input),
          idempotencyKey: r.idempotencyKey,
          ...(r.correlationId ? { correlationId: r.correlationId } : {}),
          ...(r.parentJobId ? { parentJobId: r.parentJobId } : {}),
          createdAt: stamp(),
          status: 'queued',
          events: [{ sequence: 1, at: stamp(), status: 'queued' }],
        };
        ledger.jobs.push(job);
        if (recipe) transition(job, 'running');
        await save();
        if (recipe) queueMicrotask(() => { void runRecipe(job, recipe); });
        else { notify(job); queueMicrotask(start); }
        return { jobId: job.jobId, reused: false };
      });
    },
    inspect,
    async cancel(principal: string, id: string) {
      return exclusive(async () => {
        const j = await inspect(principal, id);
        if (j.status === 'queued') {
          transition(ledger.jobs.find((x) => x.jobId === id)!, 'cancelled', 'Cancelled before it started');
          await save();
          return { jobId: id, status: 'cancelled' };
        }
        if (j.status === 'running') {
          controllers.get(id)?.abort();
          return { jobId: id, status: 'cancellation_requested' };
        }
        return { jobId: id, status: j.status };
      });
    },
    async close() {
      if (closed) return;
      stopped = true;
      for (const c of controllers.values()) c.abort();
      await draining;
      await exclusive(async () => {
        for (const j of ledger.jobs) if (j.status === 'queued') transition(j, 'interrupted', 'Host stopped before the job started');
        if (!broken) await save();
      });
      closed = true;
      await rm(lock, { recursive: true });
    },
  }; }
  host = build();
  return host;
}
export type JobHost = Awaited<ReturnType<typeof openJobHost>>;

async function requestBody(req: IncomingMessage, limit: number) {
  let n = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    n += chunk.length;
    if (n > limit + 2048) throw new HostError('input_too_large', 413);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export type ListenOptions = {
  port?: number;
  /** Bind address. Loopback by default. */
  address?: string;
  /** Serve a built web app from this directory and let same-origin browsers act as `invoker`. */
  web?: { directory: string; invoker: string };
};

function sameOrigin(req: IncomingMessage) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host ?? '';
  return origin === `http://${host}` || origin === `https://${host}`;
}

function principalFor(host: JobHost, req: IncomingMessage, web: ListenOptions['web']) {
  const authorization = req.headers.authorization;
  if (authorization) {
    if (!/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization)) throw new HostError('unauthorized', 401);
    return host.authenticate(authorization.slice(7));
  }
  if (web && sameOrigin(req)) return web.invoker;
  throw new HostError('unauthorized', 401);
}

async function serveStatic(directory: string, url: string, res: ServerResponse) {
  const root = await realpath(directory);
  const pathname = decodeURIComponent(new URL(url, 'http://x').pathname);
  const clean = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let file = resolve(root, '.' + clean);
  if (!file.startsWith(root)) file = join(root, 'index.html');
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    await stat(file);
  } catch {
    file = join(root, 'index.html');
  }
  const content = await readFile(file);
  res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', file.endsWith('index.html') ? 'no-store' : 'public, max-age=3600');
  res.end(content);
}

export async function listenJobHost(host: JobHost, options: ListenOptions | number = {}) {
  const opts: ListenOptions = typeof options === 'number' ? { port: options } : options;
  if (opts.web && !host.hasInvoker(opts.web.invoker)) throw new HostError('unknown_web_invoker');
  const limits = host.limits;
  const streams = new Set<ServerResponse>();

  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(value));
  };

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/';
    try {
      if (!url.startsWith('/v1/')) {
        if (opts.web && req.method === 'GET') return await serveStatic(opts.web.directory, url, res);
        throw new HostError('not_found', 404);
      }
      const principal = principalFor(host, req, opts.web);
      if (req.method === 'GET' && url === '/v1/capabilities') return json(res, 200, host.discover(principal));
      if (req.method === 'GET' && url === '/v1/jobs') return json(res, 200, { jobs: host.list(principal) });
      if (req.method === 'GET' && url === '/v1/recipes') return json(res, 200, { recipes: host.listRecipes(principal) });
      const recipeMatch = /^\/v1\/recipes\/([a-z][a-z0-9-]{0,63})$/.exec(url);
      if (recipeMatch && req.method === 'PUT') {
        const body = await requestBody(req, limits.inputBytes);
        if (body?.id !== recipeMatch[1]) throw new HostError('recipe_id_mismatch');
        return json(res, 200, await host.saveRecipe(principal, body));
      }
      if (recipeMatch && req.method === 'DELETE') return json(res, 200, await host.deleteRecipe(principal, recipeMatch[1]));
      if (req.method === 'GET' && url === '/v1/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': connected\n\n');
        streams.add(res);
        const unsubscribe = host.subscribe(principal, (job) => { res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`); });
        const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20000);
        req.on('close', () => { clearInterval(keepAlive); unsubscribe(); streams.delete(res); });
        return;
      }
      if (req.method === 'POST' && url === '/v1/jobs') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HostError('json_required', 415);
        return json(res, 202, await host.submit(principal, await requestBody(req, limits.inputBytes)));
      }
      const match = /^\/v1\/jobs\/([a-f0-9-]{36})(\/cancel)?$/.exec(url);
      if (!match) throw new HostError('not_found', 404);
      if (req.method === 'GET' && !match[2]) return json(res, 200, await host.inspect(principal, match[1]));
      if (req.method === 'POST' && match[2]) return json(res, 200, await host.cancel(principal, match[1]));
      throw new HostError('not_found', 404);
    } catch (e) {
      const status = e instanceof HostError ? e.status : e instanceof z.ZodError ? 400 : 400;
      const error = e instanceof HostError ? e.code : e instanceof z.ZodError ? 'invalid_input' : 'invalid_request';
      const detail = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) : undefined;
      json(res, status, detail ? { error, detail } : { error });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxConnections = 64;
  const address = opts.address ?? '127.0.0.1';
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, address, resolveListen);
  });
  const bound = server.address() as { port: number };
  return {
    url: `http://${address}:${bound.port}`,
    async close() {
      for (const s of streams) s.end();
      server.closeIdleConnections();
      await new Promise<void>((resolveClose, reject) => server.close((e) => (e ? reject(e) : resolveClose())));
      await host.close();
    },
  };
}
