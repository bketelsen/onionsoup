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

export type Discovery = {
  invoker: string;
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

  async load() {
    try {
      const [discovery, list] = await Promise.all([api<Discovery>('/v1/capabilities'), api<{ jobs: Job[] }>('/v1/jobs')]);
      this.discovery = discovery;
      const next: Record<string, Job> = {};
      for (const job of list.jobs) next[job.jobId] = job;
      this.jobs = next;
      this.error = null;
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
