import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDirectory, Runtime, stateDirectory } from '@onionsoup/owners';
import { connectOpencode } from './opencode.ts';
import { surfaceServer } from './server.ts';
import { SurfaceState } from './state.ts';

/**
 * Run the surface: `npm run surface`. Environment:
 * - SURFACE_PORT (default 4747); it listens on 127.0.0.1 only.
 * - OPENCODE_URL, with OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD, to attach to a running opencode;
 *   without OPENCODE_URL the surface starts its own `opencode serve` (which loads the onionsoup plugin).
 * - ONIONSOUP_CONFIG / ONIONSOUP_HOME as for every onionsoup command.
 */
const port = Number(process.env.SURFACE_PORT ?? 4747);
const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
const runtime = await Runtime.open({ declarations: configDirectory(), state: stateDirectory() });
const opencode = await connectOpencode({ url: process.env.OPENCODE_URL, username: process.env.OPENCODE_SERVER_USERNAME, password: process.env.OPENCODE_SERVER_PASSWORD });
const { server, pump } = surfaceServer(new SurfaceState(runtime, opencode.api), { webRoot });
const stop = new AbortController();
pump(stop.signal);
server.listen(port, '127.0.0.1', () => console.log(`onionsoup surface on http://127.0.0.1:${port} (opencode ${process.env.OPENCODE_URL ? 'attached' : 'started'} at ${opencode.url})`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stop.abort();
    server.close();
    opencode.close();
    process.exit(0);
  });
}
