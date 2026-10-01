import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { Plugin } from '@opencode-ai/plugin';
import { AdmissionRecord, beginAdmission, type AdmissionLease } from './deployment-admission.ts';
import { writeHandoffFile } from './operator-handoff-file.ts';
import { MaintenanceEffectNotStarted, MaintenanceUncertainError, type MaintenanceContext } from './maintenance-context.ts';

export const PLUGIN_MAINTENANCE_LIMITS = { budgetMs: 20_000, disposeMs: 1_000, effectTimeoutMs: 10_000 };
export const MaintenanceOperation = z.object({
  version: z.literal(1), instanceID: z.uuid(), operationID: z.uuid(), kind: z.string(), directory: z.string(),
  admission: AdmissionRecord.optional(), startedAt: z.string(), endedAt: z.string().optional(),
  status: z.enum(['running', 'stopping', 'uncertain', 'settled', 'released']), phase: z.string(),
  calls: z.array(z.object({ id: z.uuid(), method: z.string(), effect: z.boolean(),
    status: z.enum(['pending', 'uncertain']) })),
});
type Operation = z.infer<typeof MaintenanceOperation>;
type Client = Parameters<Plugin>[0]['client'];
const METHODS: Record<string, boolean> = {
  get: false, list: false, status: false, messages: false, children: false,
  create: true, prompt: true, promptAsync: true, delete: true, abort: true,
};

/** One pass owns its promises until they actually settle, even when a transport ignores abort. */
export class MaintenancePass implements MaintenanceContext {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private writing: Promise<void> = Promise.resolve();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(readonly path: string, readonly record: Operation,
    readonly limits = PLUGIN_MAINTENANCE_LIMITS) {}

  check() { this.signal.throwIfAborted(); }

  save() {
    const snapshot = JSON.stringify(MaintenanceOperation.parse(this.record), null, 2);
    this.writing = this.writing.catch(() => undefined).then(() => writeHandoffFile(this.path, snapshot));
    return this.writing;
  }

  stop() {
    this.controller.abort(new Error('plugin_maintenance_stopped'));
    if (this.record.status !== 'running') return;
    this.record.status = 'stopping';
    void this.save().catch(() => undefined);
  }

  async phase<T>(name: string, operation: () => Promise<T>): Promise<T> {
    this.check();
    this.record.phase = name;
    await this.save();
    this.check();
    return operation();
  }

  private async invoke<T>(method: string, effect: boolean, operation: () => Promise<T>) {
    if (this.signal.aborted) throw effect ? new MaintenanceEffectNotStarted() : this.signal.reason;
    const call: Operation['calls'][number] = { id: randomUUID(), method, effect, status: 'pending' };
    let invoked = false;
    try {
      this.check();
      this.record.calls.push(call);
      await this.save();
      this.check();
      invoked = true;
      const response = await operation();
      if (effect && response && typeof response === 'object' && 'error' in response && response.error) {
        throw new MaintenanceUncertainError();
      }
      if (!effect) this.check();
      return response;
    } catch (error) {
      if (effect && invoked) {
        call.status = 'uncertain';
        throw new MaintenanceUncertainError();
      }
      if (effect && !invoked) throw new MaintenanceEffectNotStarted();
      throw error;
    } finally {
      if (call.status !== 'uncertain') this.record.calls = this.record.calls.filter(current => current !== call);
      await this.save();
    }
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
        const pending = this.invoke(String(property), effect,
          () => Reflect.apply(method, target, [{ ...options, signal: AbortSignal.any(signals) }]) as Promise<unknown>);
        this.pending.add(pending);
        void pending.finally(() => this.pending.delete(pending)).catch(() => undefined);
        return pending;
      };
    } });
    return new Proxy(client, { get: (target, property) => property === 'session' ? session : Reflect.get(target, property) });
  }

  async settle() {
    // Promise.all may have rejected while sibling calls are still active. Never release ahead of those calls.
    await Promise.allSettled([...this.pending]);
    this.record.status = this.record.calls.length ? 'uncertain' : 'settled';
    this.record.endedAt = new Date().toISOString();
    await this.save();
  }
}

interface Slot {
  timer: ReturnType<typeof setInterval>;
  running?: Promise<void>;
  pass?: MaintenancePass;
  cleanup?: () => Promise<void>;
}

/** Timers belong to one actual OpenCode instance. Legacy leases are never adopted or cleaned here. */
export class PluginMaintenance {
  readonly instanceID = randomUUID();
  private stopped = false;
  private readonly slots: Slot[] = [];
  constructor(readonly home: string, readonly directory: string | (() => string),
    readonly limits = PLUGIN_MAINTENANCE_LIMITS) {}

  start(kind: string, intervalMs: number, operation: (pass: MaintenancePass) => Promise<unknown>,
    onError: (error: unknown) => void, admitted = true) {
    const slot: Slot = { timer: setInterval(() => {
      if (this.stopped || slot.running) return Promise.resolve();
      slot.running = this.tick(slot, kind, operation, admitted).catch(onError).finally(() => { slot.running = undefined; });
      return slot.running;
    }, intervalMs) };
    slot.timer.unref?.();
    this.slots.push(slot);
  }

  private async tick(slot: Slot, kind: string, operation: (pass: MaintenancePass) => Promise<unknown>, admitted: boolean) {
    if (slot.cleanup) await slot.cleanup();
    if (this.stopped) return;
    if (slot.pass?.record.status === 'uncertain') {
      const previous = slot.pass.record;
      await writeHandoffFile(join(this.home, 'plugin-maintenance', this.instanceID, 'uncertain', `${previous.operationID}.json`),
        JSON.stringify(MaintenanceOperation.parse(previous), null, 2));
    }
    const operationID = randomUUID();
    const directory = typeof this.directory === 'function' ? this.directory() : this.directory;
    const metadata = { instanceID: this.instanceID, operationID, directory };
    const lease = admitted ? await beginAdmission(this.home, kind, metadata) : undefined;
    const record = MaintenanceOperation.parse({ version: 1, ...metadata, kind, admission: lease,
      startedAt: new Date().toISOString(), status: 'running', phase: 'admitted', calls: [] });
    const path = join(this.home, 'plugin-maintenance', this.instanceID, `${kind.replaceAll(':', '-')}.json`);
    const pass = new MaintenancePass(path, record, this.limits);
    slot.pass = pass;
    if (this.stopped) pass.stop();
    const deadline = setTimeout(() => pass.stop(), this.limits.budgetMs);
    deadline.unref?.();
    try {
      await pass.save();
      pass.check();
      await operation(pass);
    } finally {
      pass.stop();
      clearTimeout(deadline);
      await pass.settle();
      if (record.status === 'settled') await this.release(slot, pass, lease);
    }
  }

  private async release(slot: Slot, pass: MaintenancePass, lease?: AdmissionLease) {
    // Persist settled proof before unlink. A failed unlink is retried by the owning slot, not a new operation.
    slot.cleanup = async () => {
      await lease?.release();
      pass.record.status = 'released';
      await pass.save();
      slot.cleanup = undefined;
    };
    await slot.cleanup();
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
    // Only positive settled proof permits a cleanup retry. Unknown and still-running calls remain admitted.
    for (const slot of this.slots) if (slot.cleanup) void slot.cleanup().catch(() => undefined);
  }
}
