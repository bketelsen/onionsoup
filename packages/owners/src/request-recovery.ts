import { reconcileAppUpdate } from './app-updates.ts';
import { reconcileInstance, reconcileDeletion } from './incus.ts';
import { reconcilePublication } from './publish-site.ts';
import { journalRequest } from './delegation.ts';
import { requireStatus, type ResourceRequest } from './requests.ts';
import type { Runtime } from './runtime.ts';

type Reconciler = (runtime: Runtime, request: ResourceRequest) => Promise<ResourceRequest | undefined>;

const CREATE_RECOVERY: Record<ResourceRequest['ask']['kind'], Reconciler> = {
  instance: async (runtime, request) => {
    const expected = request.operation?.checkpoint?.instance;
    if (!expected) return undefined;
    const instance = await reconcileInstance(runtime.incus, runtime.incusOwner(request.to), runtime.managed, request, expected);
    return instance ? { ...request, instance, status: 'provisioned', reason: 'reconciled_instance' } : undefined;
  },
  'publish-site': async (runtime, request) => {
    const published = await reconcilePublication(runtime, request);
    return published ? { ...request, published, status: 'published', reason: 'reconciled_publication' } : undefined;
  },
  'update-app': async (runtime, request) => {
    const reason = await reconcileAppUpdate(runtime, request, request.operation?.checkpoint?.jobId);
    return reason ? { ...request, status: 'updated', reason } : undefined;
  },
  work: async () => undefined,
};

const RECOVERY: Partial<Record<ResourceRequest['status'], Reconciler>> = {
  'pending-owner': async (runtime, request) => {
    const linked = (await runtime.ledger.list()).find(item => item.id === `w-request-${request.id}`);
    return linked ? { ...request, status: 'work-running', workItem: linked.id } : { ...request, status: 'pending-owner' };
  },
  'work-running': async (_runtime, request) => ({ ...request, status: 'work-running' }),
  'create-approved': (runtime, request) => CREATE_RECOVERY[request.ask.kind](runtime, request),
  'delete-approved': async (runtime, request) => {
    if (!request.instance) return undefined;
    const deleted = await reconcileDeletion(runtime.incus, runtime.incusOwner(request.to), runtime.managed, request.instance);
    return deleted ? { ...request, status: 'deleted', reason: 'reconciled_deletion' } : undefined;
  },
};

/** Reconciliation observes effects; uncertain outcomes stay in the inbox, never silently replayed. */
export async function reconcileRequest(runtime: Runtime, id: string) {
  const request = await runtime.requests.get(id);
  requireStatus(request, 'interrupted');
  const stage = request.operation?.stage;
  const reconcile = stage ? RECOVERY[stage] : undefined;
  if (!reconcile) return request;
  const reconciled = await reconcile(runtime, request);
  if (!reconciled) return request;
  const updated = await runtime.requests.update(id, current => {
    requireStatus(current, 'interrupted');
    if (current.operation?.id !== request.operation?.id) throw new Error('request_operation_changed');
    return { ...reconciled, operation: undefined };
  });
  await journalRequest(runtime, updated, 'request-recovered', updated.reason ?? updated.status);
  return updated;
}

/** The person can retry an uncertain operation after inspection, or terminate it with an audit reason. */
export async function recoverRequest(runtime: Runtime, id: string, action: 'retry' | 'cancel', by: string, reason: string) {
  const request = await runtime.requests.get(id);
  requireStatus(request, 'interrupted');
  if (!reason.trim()) throw new Error('request_recovery_reason_required');
  if (!request.operation) throw new Error('request_operation_missing');
  const updated = await runtime.requests.update(id, current => {
    requireStatus(current, 'interrupted');
    if (current.operation?.id !== request.operation?.id) throw new Error('request_operation_changed');
    const recovery = [...current.recovery, { by, action, reason, at: new Date().toISOString() }];
    const status = action === 'retry' ? current.operation!.stage : 'failed';
    return { ...current, status, reason: `${action} by ${by}: ${reason}`, recovery };
  });
  await journalRequest(runtime, updated, 'request-recovery', updated.reason!);
  return updated;
}

export async function recoverRequests(runtime: Runtime, onError: (context: string, error: unknown) => void) {
  await runtime.requests.markInterrupted();
  for (const request of await runtime.requests.withStatus('interrupted')) {
    try {
      await reconcileRequest(runtime, request.id);
    } catch (error) {
      onError(`reconcile ${request.id}`, error);
    }
  }
}
