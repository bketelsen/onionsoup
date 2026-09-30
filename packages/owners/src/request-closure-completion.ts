import { requestClosureRequestDigest, requireRequestAcceptance } from './request-closure.ts';
import type { Runtime } from './runtime.ts';

/** The ledger receipt is authoritative; retry repairs a crash before its request projection. */
export async function completeAcceptedRequest(runtime: Runtime, itemId: string) {
  const item = await runtime.ledger.get(itemId);
  const receipt = requireRequestAcceptance(item);
  const candidate = receipt.candidate;
  return runtime.requests.updateIfChanged(candidate.request, current => {
    if (current.id !== item.request || current.workItem !== item.id || current.to !== item.owner
      || requestClosureRequestDigest(current) !== candidate.requestDigest) throw new Error('request_acceptance_request_changed');
    const reason = `${item.id}: goal accepted by ${receipt.by}; closure ${candidate.digest}`;
    if (current.status === 'completed' && current.reason === reason) return undefined;
    if (current.status !== 'work-running') throw new Error('request_acceptance_request_not_running');
    return { ...current, status: 'completed', reason };
  });
}
