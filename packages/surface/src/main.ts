import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDirectory, openWiki, Runtime, stateDirectory } from '@onionsoup/owners';
import { DEFAULT_RELEASE_MANIFEST, readReleaseBuildId } from './deployment-view.ts';
import { connectOpencode, publishOpencodeEndpoint } from './opencode.ts';
import { surfaceServer } from './server.ts';
import { SurfaceState } from './state.ts';
import { startWikiSite } from './wiki-site.ts';

/**
 * Run the surface: `npm run surface`. Environment:
 * - SURFACE_PORT (default 4747); it listens on 127.0.0.1 only.
 * - OPENCODE_URL, with OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD, to attach to a running opencode;
 *   without OPENCODE_URL the surface starts its own `opencode serve` (which loads the onionsoup plugin).
 * - ONIONSOUP_CONFIG / ONIONSOUP_HOME as for every onionsoup command.
 * - ONIONSOUP_RELEASE_MANIFEST optionally points to the installed release's identity JSON,
 *   read and validated once at startup.
 * With a wiki.yaml in the configuration, the wiki is also served, read-only, where its `listen` says.
 */
const port = Number(process.env.SURFACE_PORT ?? 4747);
const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
const buildId = await readReleaseBuildId(process.env.ONIONSOUP_RELEASE_MANIFEST ?? DEFAULT_RELEASE_MANIFEST);
const runtime = await Runtime.open({ declarations: configDirectory(), state: stateDirectory() });
const opencode = await connectOpencode({ url: process.env.OPENCODE_URL, username: process.env.OPENCODE_SERVER_USERNAME, password: process.env.OPENCODE_SERVER_PASSWORD });
const { server, pump } = surfaceServer(new SurfaceState(runtime, opencode.api), { webRoot, buildId });
const stop = new AbortController();
pump(stop.signal);
server.listen(port, '127.0.0.1', () => console.log(`onionsoup surface on http://127.0.0.1:${port}`));
const wikiSite = runtime.declarations.wiki ? await startWikiSite(openWiki(runtime)) : undefined;
if (wikiSite) console.log(`onionsoup wiki on http://${runtime.declarations.wiki!.listen.host}:${runtime.declarations.wiki!.listen.port}`);
const removeEndpoint = opencode.endpoint
  ? await publishOpencodeEndpoint(runtime.stateDirectory, { url: opencode.url, ...opencode.endpoint })
  : undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stop.abort();
    server.close();
    wikiSite?.close();
    opencode.close();
    void removeEndpoint?.().finally(() => process.exit(0));
    if (!removeEndpoint) process.exit(0);
  });
}
