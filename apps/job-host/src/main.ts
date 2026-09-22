import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openJobHost, listenJobHost, tokenHash, type Invoker } from '@onionsoup/job-host';
import { HostConfig, registeredCapabilities, resolveCapabilityConfig, RepositoryRegistry, repositoryEntries } from '@onionsoup/host-capabilities';
import { readJson } from '@onionsoup/runtime/storage';
import { createChatService } from './chat.ts';
import { repositoriesRoute } from './repositories.ts';

globalThis.AI_SDK_LOG_WARNINGS = false;

const usage = 'Usage: npm run jobs -- --config HOST_CONFIG [--port N]\n';

async function main() {
  const { values } = parseArgs({ strict: true, options: { config: { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    process.stdout.write(usage);
    return;
  }
  if (!values.config) throw Error('Configuration required. ' + usage);
  const path = resolve(values.config);
  // Operator-only configuration, never accepted through the job API.
  const config = HostConfig.parse(await readJson(path));
  const capabilities = resolveCapabilityConfig(config.capabilities, path);
  const invokers: Invoker[] = [];
  for (const i of config.invokers) {
    const invoker: Invoker = { id: i.id, capabilities: i.capabilities };
    if (i.maxJobs) invoker.maxJobs = i.maxJobs;
    if (i.tokenFile) {
      const token = (await readFile(resolve(dirname(path), i.tokenFile), 'utf8')).trim();
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw Error(`Invalid token for invoker ${i.id}`);
      invoker.tokenHash = tokenHash(token);
    }
    invokers.push(invoker);
  }
  const recipes = await Promise.all(config.recipes.map((file) => readJson(resolve(dirname(path), file))));
  const registry = await RepositoryRegistry.open({
    directory: resolve(dirname(path), config.directory, 'repositories'),
    entries: repositoryEntries(capabilities),
    ...(config.sandbox?.nodeRuntime ? { nodeRuntime: resolve(dirname(path), config.sandbox.nodeRuntime) } : {}),
  });
  const host = await openJobHost({
    directory: resolve(dirname(path), config.directory),
    binding: capabilities,
    capabilities: registeredCapabilities(capabilities, { apiKey: process.env.TRUENAS_API_KEY, registry }),
    invokers,
    recipes,
    ...(config.limits ? { limits: config.limits } : {}),
  });
  const chat = createChatService({ host, directory: resolve(dirname(path), config.directory, 'chat'), provider: config.capabilities.provider, allowInteractive: config.chat?.interactive ?? true });
  let listener;
  try {
    listener = await listenJobHost(host, {
      port: values.port ? Number(values.port) : config.port,
      address: config.address,
      routes: [chat.routes, repositoriesRoute(registry)],
      ...(config.tailscale ? { tailscale: { users: Object.fromEntries(config.tailscale.users.map((user) => [user.login, user.invoker])) } } : {}),
      ...(config.web ? { web: { directory: resolve(dirname(path), config.web.directory), invoker: config.web.invoker } } : {}),
    });
  } catch (e) {
    await host.close();
    throw e;
  }
  process.stdout.write(JSON.stringify({ url: listener.url, pid: process.pid, web: Boolean(config.web) }) + '\n');
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void chat.close().finally(() => listener.close());
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

main().catch((e) => {
  process.stderr.write(`Job host stopped: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
