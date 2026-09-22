export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export type Job = {
  jobId: string;
  owner: string;
  capability: string;
  version: string;
  input: unknown;
  idempotencyKey: string;
  correlationId?: string;
  parentJobId?: string;
  createdAt: string;
  status: JobStatus;
  events: { sequence: number; at: string; status: JobStatus }[];
  error?: string;
  outcome?: { status: 'ok' | 'partial' | 'failed'; label: string };
  result?: unknown;
};

export type Capability = {
  id: string;
  version: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  metadata: unknown;
  effects: string[];
  timeoutMs: number;
  interactive?: boolean;
};

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  description?: string;
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  anyOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
};

export type Binding = { $param: string } | { $job: string } | { $result: [string, string] };
export type Step = { id: string; capability: string; input: Record<string, unknown>; continueOnFailure?: boolean };
export type Recipe = {
  schemaVersion: 1;
  id: string;
  title: string;
  description?: string;
  steps: Step[];
  params?: Record<string, JsonSchema>;
  layout?: Record<string, { x: number; y: number }>;
  paramSchema?: Record<string, JsonSchema>;
};

export type ChatReference = { id: string; findingId?: string };
export type ChatTurn = {
  turnId: string;
  message: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  answer?: { kind: 'answer' | 'clarification' | 'unsupported'; text: string; basis: string; references: ChatReference[] };
  failure?: string;
  steps: number;
  toolCalls: number;
  events: { at: string; tool: string; stage: string; details: unknown }[];
};
export type ChatSessionSummary = { sessionId: string; createdAt: string; turns: number; title: string; lastAt: string };
export type ChatSession = { sessionId: string; createdAt: string; turns: ChatTurn[] };

export type HomelabSource = { sourceId: string; kind: 'truenas' | 'containers' | 'kubernetes'; origin: 'config' | 'registry'; host: string; detail: string; latestObservation: { at: string; status: string } | null; latestInvestigation: { at: string; status: string; summary: string } | null };
export type RegisteredRepository = { name: string; origin: 'config' | 'registry'; checkout: boolean; implementation: boolean; onboardedAt?: string; profile?: any };

export type Discovery = {
  invoker: string;
  login?: string;
  remainingAdmissions: number | null;
  capabilities: Capability[];
  limits: Record<string, number>;
};

export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number, readonly detail?: string[]) {
    super(detail?.length ? `${code}: ${detail.join('; ')}` : code);
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new ApiError(body.error ?? 'request_failed', response.status, body.detail);
  return body as T;
}

class Store {
  discovery = $state<Discovery | null>(null);
  jobs = $state<Record<string, Job>>({});
  recipes = $state<Recipe[]>([]);
  chatSessions = $state<ChatSessionSummary[]>([]);
  repositories = $state<RegisteredRepository[]>([]);
  sources = $state<HomelabSource[]>([]);
  nodeRuntime = $state(false);
  chatSession = $state<ChatSession | null>(null);
  chatBusy = $state(false);
  connected = $state(false);
  error = $state<string | null>(null);
  private source: EventSource | null = null;

  get capabilities() {
    return this.discovery?.capabilities ?? [];
  }

  get jobList() {
    return Object.values(this.jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  capability(id: string) {
    return this.capabilities.find((c) => c.id === id);
  }

  /** Capabilities a recipe step may use: everything granted that is not itself a recipe. */
  get stepCapabilities() {
    return this.capabilities.filter((c) => !c.id.startsWith('recipe.') && !c.interactive);
  }

  async loadSources() {
    const data = await api<{ sources: HomelabSource[] }>('/v1/homelab/sources');
    this.sources = data.sources;
  }

  async loadRepositories() {
    const data = await api<{ repositories: RegisteredRepository[]; nodeRuntime: boolean }>('/v1/repositories');
    this.repositories = data.repositories;
    this.nodeRuntime = data.nodeRuntime;
  }

  async loadChatSessions() {
    const { sessions } = await api<{ sessions: ChatSessionSummary[] }>('/v1/chat/sessions');
    this.chatSessions = sessions;
  }

  async openChatSession(sessionId: string) {
    const { session } = await api<{ session: ChatSession }>(`/v1/chat/sessions/${sessionId}`);
    this.chatSession = { ...session, sessionId };
  }

  async createChatSession() {
    const created = await api<{ sessionId: string; session: ChatSession }>('/v1/chat/sessions', { method: 'POST', body: '{}' });
    this.chatSession = { ...created.session, sessionId: created.sessionId };
    await this.loadChatSessions();
    return created.sessionId;
  }

  async sendChat(message: string) {
    if (!this.chatSession) throw new Error('No session');
    const sessionId = this.chatSession.sessionId;
    this.chatBusy = true;
    const pending: ChatTurn = { turnId: 'pending', message, startedAt: new Date().toISOString(), status: 'running', steps: 0, toolCalls: 0, events: [] };
    this.chatSession.turns.push(pending);
    try {
      const { turn } = await api<{ turn: ChatTurn }>(`/v1/chat/sessions/${sessionId}/turns`, { method: 'POST', body: JSON.stringify({ message }) });
      if (this.chatSession?.sessionId === sessionId) this.chatSession.turns.splice(this.chatSession.turns.indexOf(pending), 1, turn);
      await this.load();
      await this.loadChatSessions();
      return turn;
    } catch (e) {
      if (this.chatSession?.sessionId === sessionId) this.chatSession.turns.splice(this.chatSession.turns.indexOf(pending), 1);
      throw e;
    } finally {
      this.chatBusy = false;
    }
  }

  async loadRecipes() {
    const { recipes } = await api<{ recipes: Recipe[] }>('/v1/recipes');
    this.recipes = recipes;
  }

  async saveRecipe(recipe: Recipe) {
    const { paramSchema: _ignored, ...body } = recipe;
    const saved = await api<Recipe>(`/v1/recipes/${recipe.id}`, { method: 'PUT', body: JSON.stringify(body) });
    this.recipes = [...this.recipes.filter((r) => r.id !== saved.id), saved].sort((a, b) => a.id.localeCompare(b.id));
    await this.load();
    return saved;
  }

  async deleteRecipe(id: string) {
    await api(`/v1/recipes/${id}`, { method: 'DELETE' });
    this.recipes = this.recipes.filter((r) => r.id !== id);
    await this.load();
  }

  async load() {
    try {
      const [discovery, list] = await Promise.all([api<Discovery>('/v1/capabilities'), api<{ jobs: Job[] }>('/v1/jobs')]);
      this.discovery = discovery;
      const next: Record<string, Job> = {};
      for (const job of list.jobs) next[job.jobId] = job;
      this.jobs = next;
      this.error = null;
      await this.loadRecipes().catch(() => {});
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.listen();
  }

  private listen() {
    if (this.source) return;
    this.source = new EventSource('/v1/events');
    this.source.onopen = () => { this.connected = true; };
    this.source.onerror = () => { this.connected = false; };
    this.source.addEventListener('job', (event) => {
      const job = JSON.parse((event as MessageEvent).data) as Job;
      const previous = this.jobs[job.jobId];
      // Transitions never carry results; keep one already fetched unless the status moved on.
      this.jobs[job.jobId] = previous?.result !== undefined && previous.status === job.status ? { ...job, result: previous.result } : job;
    });
  }

  async submit(capability: string, input: unknown) {
    const idempotencyKey = crypto.randomUUID();
    const { jobId } = await api<{ jobId: string; reused: boolean }>('/v1/jobs', { method: 'POST', body: JSON.stringify({ capability, input, idempotencyKey }) });
    await this.refresh(jobId);
    return jobId;
  }

  async refresh(jobId: string) {
    const job = await api<Job>(`/v1/jobs/${jobId}`);
    this.jobs[jobId] = job;
    return job;
  }

  async cancel(jobId: string) {
    await api(`/v1/jobs/${jobId}/cancel`, { method: 'POST', body: '{}' });
    await this.refresh(jobId);
  }
}

export const store = new Store();
