import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDirectory, openWiki, Runtime, stateDirectory, maintenanceQuarantineStatus, acknowledgeMaintenanceQuarantine,
  maintenanceReleaseRuntimeState, acknowledgeMaintenanceRelease, claimMaintenanceReleaseStartup,
  MAINTENANCE_RELEASE_LIMITS, type MaintenanceReleaseState } from '@onionsoup/owners';
import { DEFAULT_RELEASE_MANIFEST, readReleaseBuildId } from './deployment-view.ts';
import { connectOpencode, publishOpencodeEndpoint, type OpencodeConnection } from './opencode.ts';
import { surfaceServer, quarantineSurfaceServer } from './server.ts';
import { SurfaceState } from './state.ts';
import { startWikiSync } from './wiki-site.ts';

/** Own OpenCode normally; during maintenance expose diagnostics until bound observation approval arrives. */
const port = Number(process.env.SURFACE_PORT ?? 4747);
const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
const home = stateDirectory();
const quarantine = await maintenanceQuarantineStatus(home);
const buildId = await readReleaseBuildId(process.env.ONIONSOUP_RELEASE_MANIFEST ?? DEFAULT_RELEASE_MANIFEST).catch(error => {
  if (quarantine.state === 'absent') throw error;
  return null;
});
const acknowledgment = quarantine.state === 'absent' ? undefined
  : await acknowledgeMaintenanceQuarantine(home, buildId, 'surface').catch(error => {
    console.warn('maintenance_quarantine_ack_failed', error instanceof Error ? error.message : String(error));
    return undefined;
  });
const runtime = await Runtime.open({ declarations: configDirectory(), state: home });
let application: { server: ReturnType<typeof createServer>; pump(signal: AbortSignal): void } = quarantineSurfaceServer(home, { buildId, acknowledgment });
const server = createServer((request, response) => application.server.emit('request', request, response));
const stop = new AbortController();
let opencode: OpencodeConnection | undefined;
let removeEndpoint: (() => Promise<void>) | undefined;
let stopWikiSync: (() => void) | undefined;
server.listen(port, '127.0.0.1', () => console.log(`onionsoup surface on http://127.0.0.1:${port}`));

async function startSurfaceOpencode(release: MaintenanceReleaseState | undefined) {
  if (release?.phase === 'observation') {
    // Observation must never attach to an independently running or foreign server.
    if (process.env.OPENCODE_URL) throw new Error('maintenance_release_owned_opencode_required');
    await claimMaintenanceReleaseStartup(home, release.observation);
  }
  if (stop.signal.aborted) return;
  opencode = await connectOpencode({ url: process.env.OPENCODE_URL,
    username: process.env.OPENCODE_SERVER_USERNAME, password: process.env.OPENCODE_SERVER_PASSWORD });
  if (stop.signal.aborted) {
    opencode.close();
    return;
  }
  removeEndpoint = opencode.endpoint
    ? await publishOpencodeEndpoint(home, { url: opencode.url, ...opencode.endpoint }) : undefined;
  const wiki = runtime.declarations.wiki ? openWiki(runtime) : undefined;
  application = surfaceServer(new SurfaceState(runtime, opencode.api), { webRoot, buildId, wiki });
}

async function activateSurface() {
  let observationAcknowledged = false;
  while (!stop.signal.aborted) {
    const status = await maintenanceQuarantineStatus(home);
    const release = await maintenanceReleaseRuntimeState(home);
    if (!opencode && (status.state === 'absent' || release?.phase === 'observation')) await startSurfaceOpencode(release);
    if (opencode && release?.phase === 'observation' && !observationAcknowledged) {
      await acknowledgeMaintenanceRelease(home, release.observation, 'surface', 'observation');
      observationAcknowledged = true;
    }
    if (opencode && (await maintenanceQuarantineStatus(home)).state === 'absent') {
      // No event auto-answer, periodic refresh or wiki synchronization runs before committed release.
      application.pump(stop.signal);
      if (runtime.declarations.wiki) stopWikiSync = await startWikiSync(openWiki(runtime));
      if (release?.phase === 'released') await acknowledgeMaintenanceRelease(home, release.observation, 'surface', 'released');
      return;
    }
    await sleep(MAINTENANCE_RELEASE_LIMITS.pollMs, undefined, { signal: stop.signal }).catch(() => {});
  }
}
void activateSurface().catch(error => {
  // A possibly accepted startup is not retried. Keep diagnostics and the durable claim for inspection.
  console.warn('maintenance_surface_activation_failed', error instanceof Error ? error.message : String(error));
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stop.abort();
    server.close();
    stopWikiSync?.();
    opencode?.close();
    void removeEndpoint?.().finally(() => process.exit(0));
    if (!removeEndpoint) process.exit(0);
  });
}
