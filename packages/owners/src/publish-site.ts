import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { HostedSite, TruenasDomain } from './declarations.ts';
import type { ResourceRequest } from './requests.ts';
import type { Runtime } from './runtime.ts';
import { runSandboxed } from './sandbox.ts';
import { rsyncTo, ssh, TRUENAS_LIMITS, withTruenas } from './truenas.ts';
import { refreshCheckout } from './workspace.ts';

/**
 * Publishing a static site is deterministic host code, never a model: build the source owner's base
 * branch with its pinned build command in the sandbox, stage next to the live site, swap atomically
 * (keeping site.prev-<time>, the convention already on the dataset), restart the app through the TrueNAS
 * API so its bind mount follows the new directory, and verify the served index.html byte for byte.
 * Anything failing after the swap rolls back.
 */
function quoted(path: string) {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export function requireSite(domain: TruenasDomain, siteId: string) {
  const site = domain.sites.find(candidate => candidate.id === siteId);
  if (!site) throw new Error(`unknown_site: ${siteId}`);
  return site;
}

async function build(runtime: Runtime, site: HostedSite, output: string) {
  const source = runtime.repositoryOwner(site.source);
  const commit = await refreshCheckout(source);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const [command, ...args] = site.build.map(word => word.replaceAll('{tools}', runtime.toolsDirectory).replaceAll('{out}', output));
  const result = await runSandboxed(command!, args, { cwd: source.workspace, writable: [output] });
  if (result.exitCode !== 0) throw new Error(`build_failed: ${result.output.slice(-400)}`);
  return { commit, index: await readFile(join(output, 'index.html'), 'utf8') };
}

async function restartApp(domain: TruenasDomain, app: string) {
  await withTruenas(domain, true, call => call('truenas_app_restart', { name: app }));
}

/** Poll until the served index.html is exactly what was built. */
async function waitForSite(url: string, expected: string) {
  const deadline = Date.now() + TRUENAS_LIMITS.restartWaitMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    await sleep(TRUENAS_LIMITS.pollMs);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000), headers: { 'cache-control': 'no-cache' } });
      const body = await response.text();
      if (response.ok && body === expected) return;
      last = response.ok ? 'served index.html differs from the build' : `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`verify_failed: ${last}`);
}

export async function publishSite(runtime: Runtime, request: ResourceRequest) {
  if (request.ask.kind !== 'publish-site') throw new Error('not_a_publish_request');
  const owner = runtime.truenasOwner(request.to);
  const domain = owner.domain;
  const site = requireSite(domain, request.ask.site);
  const built = await build(runtime, site, join(runtime.stateDirectory, 'builds', request.id));
  const time = stamp();
  const live = `${site.path}/site`;
  const staging = `${site.path}/site.staging-${time}`;
  const previous = `${site.path}/site.prev-${time}`;
  const publication = { commit: built.commit, previous, digest: createHash('sha256').update(built.index).digest('hex') };
  if (request.operation) {
    request.operation.checkpoint = { ...request.operation.checkpoint, publication };
    await runtime.requests.checkpoint(request.id, { publication });
  }
  await rsyncTo(domain, join(runtime.stateDirectory, 'builds', request.id), staging);
  const user = domain.ssh.user;
  await ssh(domain, `sudo chown -R ${user}:${user} ${quoted(staging)} && sudo mv ${quoted(live)} ${quoted(previous)} && sudo mv ${quoted(staging)} ${quoted(live)}`);
  try {
    await restartApp(domain, site.app);
    await waitForSite(site.url, built.index);
    if (request.operation) {
      const verified = { ...publication, verifiedAt: new Date().toISOString() };
      request.operation.checkpoint = { ...request.operation.checkpoint, publication: verified };
      await runtime.requests.checkpoint(request.id, { publication: verified });
    }
  } catch (error) {
    await ssh(domain, `sudo mv ${quoted(live)} ${quoted(`${site.path}/site.failed-${time}`)} && sudo mv ${quoted(previous)} ${quoted(live)}`).catch(() => undefined);
    await restartApp(domain, site.app).catch(() => undefined);
    throw new Error(`${error instanceof Error ? error.message : error}; rolled back to the previous site`);
  }
  return { commit: built.commit, previous };
}

/** Confirm the exact built content without replaying a swap or restart after an interruption. */
export async function reconcilePublication(runtime: Runtime, request: ResourceRequest) {
  if (request.ask.kind !== 'publish-site') throw new Error('not_a_publish_request');
  const checkpoint = request.operation?.checkpoint?.publication;
  if (!checkpoint?.verifiedAt) return undefined;
  const site = requireSite(runtime.truenasOwner(request.to).domain, request.ask.site);
  const response = await fetch(site.url, { signal: AbortSignal.timeout(5_000), headers: { 'cache-control': 'no-cache' } });
  if (!response.ok) return undefined;
  const digest = createHash('sha256').update(await response.text()).digest('hex');
  if (digest !== checkpoint.digest) return undefined;
  return { commit: checkpoint.commit, previous: checkpoint.previous, at: new Date().toISOString() };
}
