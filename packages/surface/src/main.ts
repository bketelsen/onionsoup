import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDirectory, openWiki, Runtime, stateDirectory, maintenanceQuarantineStatus, acknowledgeMaintenanceQuarantine } from '@onionsoup/owners';
import { DEFAULT_RELEASE_MANIFEST, readReleaseBuildId } from './deployment-view.ts';
import { connectOpencode, publishOpencodeEndpoint } from './opencode.ts';
import { surfaceServer, quarantineSurfaceServer } from './server.ts';
import { SurfaceState } from './state.ts';
import { startWikiSync } from './wiki-site.ts';

/**
 * Run the surface: `npm run surface`. Environment:
 * - SURFACE_PORT (default 4747); it listens on 127.0.0.1 only.
 * - OPENCODE_URL, with OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD, to attach to a running opencode;
 *   without OPENCODE_URL the surface starts its own `opencode serve` (which loads the onionsoup plugin).
 * - ONIONSOUP_CONFIG / ONIONSOUP_HOME as for every onionsoup command.
 * - ONIONSOUP_RELEASE_MANIFEST optionally points to the installed release's identity JSON,
 *   read and validated once at startup.
 * With a wiki.yaml in the configuration, the wiki is also served, read-only, at /wiki/.
 */
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
const opencode = quarantine.state === 'absent' ? await connectOpencode({ url: process.env.OPENCODE_URL, username: process.env.OPENCODE_SERVER_USERNAME, password: process.env.OPENCODE_SERVER_PASSWORD }) : undefined;
const wiki = opencode && runtime.declarations.wiki ? openWiki(runtime) : undefined;
const { server, pump } = opencode ? surfaceServer(new SurfaceState(runtime, opencode.api), { webRoot, buildId, wiki })
  : quarantineSurfaceServer(home, { buildId, acknowledgment });
const stop = new AbortController();
pump(stop.signal);
server.listen(port, '127.0.0.1', () => console.log(`onionsoup surface on http://127.0.0.1:${port}`));
const stopWikiSync = wiki ? await startWikiSync(wiki) : undefined;
const removeEndpoint = opencode?.endpoint
  ? await publishOpencodeEndpoint(runtime.stateDirectory, { url: opencode.url, ...opencode.endpoint })
  : undefined;
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
