import { randomUUID } from 'node:crypto';
import type { Plugin } from '@opencode-ai/plugin';
import { beginAdmission } from './deployment-admission.ts';
import { MaintenanceEffectNotStarted, MaintenanceUncertainError, type MaintenanceContext } from './maintenance-context.ts';

export const PLUGIN_MAINTENANCE_LIMITS = { budgetMs: 20_000, disposeMs: 1_000, effectTimeoutMs: 10_000 };
type Client = Parameters<Plugin>[0]['client'];
/** Whether each SDK session method has an effect outside the plugin. */
const METHODS: Record<string, boolean> = {
  get: false, list: false, status: false, messages: false, children: false,
  create: true, prompt: true, promptAsync: true, delete: true, abort: true,
};

function isErrorResponse(response: unknown) {
  return !!response && typeof response === 'object' && 'error' in response && !!response.error;
}

/** One pass owns its SDK calls until they actually settle, even when a transport ignores abort. */
export class MaintenancePass implements MaintenanceContext {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  currentPhase = 'admitted';
  private readonly pending = new Set<Promise<unknown>>();
  constructor(readonly limits = PLUGIN_MAINTENANCE_LIMITS) {}

  check() { this.signal.throwIfAborted(); }

  stop() { this.controller.abort(new Error('plugin_maintenance_stopped')); }

  async phase<T>(name: string, operation: () => Promise<T>): Promise<T> {
    this.check();
    this.currentPhase = name;
    return operation();
  }

  /** A stopped pass never starts an effect; an invoked effect that fails is uncertain, not proven unsent. */
  private async invoke<T>(effect: boolean, operation: () => Promise<T>) {
    if (this.signal.aborted) throw effect ? new MaintenanceEffectNotStarted() : this.signal.reason;
    let response: T;
    try {
      response = await operation();
    } catch (error) {
      if (effect) throw new MaintenanceUncertainError();
      throw error;
    }
    if (effect && isErrorResponse(response)) throw new MaintenanceUncertainError();
    if (!effect) this.check();
    return response;
  }

  /** Only this pass's adapters use this client; foreground tools and detached workers retain their own lifecycle. */
  client(client: Client): Client {
    const session = new Proxy(client.session, { get: (target, property) => {
      const method = Reflect.get(target, property);
      if (typeof method !== 'function') return method;
      return (options: Record<string, unknown> = {}) => {
        const effect = METHODS[String(property)];
        if (effect === undefined) throw new Error('plugin_maintenance_method_unsupported');
        const signals = [effect ? AbortSignal.timeout(this.limits.effectTimeoutMs) : this.signal];
        if (options.signal instanceof AbortSignal) signals.push(options.signal);
        const pending = this.invoke(effect,
          () => Reflect.apply(method, target, [{ ...options, signal: AbortSignal.any(signals) }]) as Promise<unknown>);
        this.pending.add(pending);
        void pending.finally(() => this.pending.delete(pending)).catch(() => undefined);
        return pending;
      };
    } });
    return new Proxy(client, { get: (target, property) => property === 'session' ? session : Reflect.get(target, property) });
  }

  /** Promise.all may have rejected while sibling calls are still active. Never release ahead of those calls. */
  async settle() {
    await Promise.allSettled([...this.pending]);
  }
}

/**
 * Kinds that do the same process-wide work in every OpenCode instance (every call names its directory). One
 * OpenCode process hosts an instance per directory, each loading this plugin; only one of them runs these.
 */
const PROCESS_WIDE_KINDS = new Set(['plugin:notices']);
const processHolders = new Map<string, string>();

interface Slot {
  timer: ReturnType<typeof setInterval>;
  running?: Promise<void>;
  pass?: MaintenancePass;
}

/** Timers belong to one actual OpenCode instance; each pass holds an admission lease until its calls settle. */
export class PluginMaintenance {
  readonly instanceID = randomUUID();
  private stopped = false;
  private readonly slots: Slot[] = [];
  constructor(readonly home: string, readonly limits = PLUGIN_MAINTENANCE_LIMITS) {}

  start(kind: string, intervalMs: number, operation: (pass: MaintenancePass) => Promise<unknown>,
    onError: (error: unknown) => void, admitted = true) {
    const slot: Slot = { timer: setInterval(() => {
      if (this.stopped || slot.running || !this.holds(kind)) return Promise.resolve();
      slot.running = this.tick(slot, kind, operation, admitted).catch(onError).finally(() => { slot.running = undefined; });
      return slot.running;
    }, intervalMs) };
    slot.timer.unref?.();
    this.slots.push(slot);
  }

  /** The first live instance to tick a process-wide kind runs it until it is disposed. */
  private holds(kind: string) {
    if (!PROCESS_WIDE_KINDS.has(kind)) return true;
    const holder = processHolders.get(kind) ?? this.instanceID;
    processHolders.set(kind, holder);
    return holder === this.instanceID;
  }

  private async tick(slot: Slot, kind: string, operation: (pass: MaintenancePass) => Promise<unknown>, admitted: boolean) {
    const lease = admitted ? await beginAdmission(this.home, kind) : undefined;
    const pass = new MaintenancePass(this.limits);
    slot.pass = pass;
    if (this.stopped) pass.stop();
    const deadline = setTimeout(() => {
      console.warn('plugin_maintenance_budget_exceeded', kind, pass.currentPhase);
      pass.stop();
    }, this.limits.budgetMs);
    deadline.unref?.();
    try {
      pass.check();
      await operation(pass);
    } finally {
      pass.stop();
      clearTimeout(deadline);
      await pass.settle();
      await lease?.release();
    }
  }

  async dispose() {
    this.stopped = true;
    for (const slot of this.slots) {
      clearInterval(slot.timer);
      slot.pass?.stop();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(this.slots.map(slot => slot.running)),
        new Promise<void>(resolve => { timer = setTimeout(resolve, this.limits.disposeMs); }),
      ]);
    } finally { clearTimeout(timer); }
    for (const [kind, holder] of processHolders) if (holder === this.instanceID) processHolders.delete(kind);
  }
}
