import { join } from 'node:path';
import { z } from 'zod';
import { readOpencodeEndpoint } from './deploy-admission.mjs';
import { endpointIdentity } from './notice-admission-probe.mjs';
import { durableExclusive, optionalRecord } from './maintenance-recovery-storage.mjs';
import { fail, hash } from './admission-recovery-proof.mjs';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Attempt = z.object({ version: z.literal(1), digest: Digest, endpointDigest: Digest, at: z.iso.datetime() }).strict();
const Confirmed = Attempt.extend({ confirmedAt: z.iso.datetime() }).strict();
function paths(archive, digest) {
  return { attempt: join(archive, 'activation', `${digest}-attempt.json`),
    confirmed: join(archive, 'activation', `${digest}-confirmed.json`) };
}
export async function activationState(archive, digest) {
  const locations = paths(archive, digest);
  const attempt = await optionalRecord(locations.attempt, Attempt);
  const confirmed = await optionalRecord(locations.confirmed, Confirmed);
  if (attempt && attempt.digest !== digest) throw fail('maintenance_release_activation_receipt_invalid');
  if (confirmed && (!attempt || confirmed.digest !== attempt.digest || confirmed.endpointDigest !== attempt.endpointDigest
    || confirmed.at !== attempt.at)) throw fail('maintenance_release_activation_receipt_invalid');
  return { attempt, confirmed };
}

async function nativeRequest(endpoint, path, method) {
  const authorization = `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString('base64')}`;
  const response = await fetch(new URL(path, endpoint.url), { method, headers: { authorization }, redirect: 'error',
    signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw fail('maintenance_release_activation_unavailable');
  return response.json();
}

/** No directory reads here: those would recreate observation-only MCP configurations. */
export async function activationHealth(context, proof, effects) {
  const endpoint = await (effects.endpoint ?? readOpencodeEndpoint)(context.selection.state);
  if (hash(endpointIdentity(endpoint)) !== hash(proof.endpoint)) throw fail('maintenance_release_endpoint_changed');
  const health = await (effects.globalHealth ?? (endpoint => nativeRequest(endpoint, '/global/health', 'GET')))(endpoint);
  if (health?.healthy !== true) throw fail('maintenance_release_activation_unhealthy');
  return endpoint;
}

/** Dispose only the authenticated, proven idle observation runtime. No prompt/session is created or retried. */
export async function prepareMaintenanceActivation(context, proof, digest, archive, effects) {
  const saved = await activationState(archive, digest);
  const endpoint = await activationHealth(context, proof, effects);
  if (saved.attempt && saved.attempt.endpointDigest !== hash(proof.endpoint)) {
    throw fail('maintenance_release_activation_receipt_invalid');
  }
  if (saved.confirmed) return saved.confirmed;
  if (saved.attempt) throw fail('maintenance_release_activation_uncertain_gate_held');
  const attempt = Attempt.parse({ version: 1, digest, endpointDigest: hash(proof.endpoint), at: new Date().toISOString() });
  await durableExclusive(paths(archive, digest).attempt, attempt);
  const disposed = await (effects.disposeObservation ?? (endpoint => nativeRequest(endpoint, '/global/dispose', 'POST')))(endpoint);
  if (disposed !== true) throw fail('maintenance_release_activation_unconfirmed_gate_held');
  await activationHealth(context, proof, effects);
  const confirmed = Confirmed.parse({ ...attempt, confirmedAt: new Date().toISOString() });
  await durableExclusive(paths(archive, digest).confirmed, confirmed);
  return confirmed;
}
