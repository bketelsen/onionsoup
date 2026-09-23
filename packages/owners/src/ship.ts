import { execFile } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RepositoryOwner } from './declarations.ts';
import type { Runtime } from './runtime.ts';
import { runSandboxed } from './sandbox.ts';
import { expandHome } from './truenas.ts';
import { git } from './workspace.ts';

const run = promisify(execFile);

export const SHIP_LIMITS = { restartDelaySeconds: 5, healthWaitSeconds: 45 };

/**
 * Shipping onionsoup is deterministic host code: fast-forward the running checkout to the base branch, install
 * and verify it in the sandbox (rolling back on failure), then restart the services from a separate, delayed
 * systemd unit that survives the daemon restarting itself, checks the daemon comes back, and rolls back and
 * restarts again if it does not.
 */
export interface ShipResult { outcome: 'shipped' | 'nothing-to-ship' | 'failed'; summary: string; from?: string; to?: string }

export function hasShipGrant(owner: RepositoryOwner) {
  return owner.grants.some(grant => grant.to === owner.id && grant.action === 'ship' && (grant.target === owner.domain.name || grant.target === '*'));
}

/** A small watchdog script run by systemd after the ship: restart, check health, roll back on failure. */
function watchdogScript(ownerId: string, checkout: string, previous: string, services: readonly string[], journal: string) {
  const units = services.join(' ');
  return `#!/bin/sh
# Written by onionsoup's ship action. Restarts the services, confirms they come back, rolls back if not.
record() { printf '{"at":"%s","owner":"${ownerId}","kind":"%s","note":"%s"}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >> '${journal}'; }
systemctl --user restart ${units}
sleep ${SHIP_LIMITS.healthWaitSeconds}
healthy=1
for unit in ${units}; do systemctl --user is-active --quiet "$unit" || healthy=0; done
if [ "$healthy" = 1 ]; then record shipped "services healthy after restart"; exit 0; fi
record attention "ship failed health check; rolling back to ${previous.slice(0, 12)}"
cd '${checkout}' && git reset -q --hard '${previous}' && npm ci --no-audit --no-fund >/dev/null 2>&1
systemctl --user restart ${units}
`;
}

export async function shipEngine(runtime: Runtime, ownerId: string): Promise<ShipResult> {
  const owner = runtime.repositoryOwner(ownerId);
  if (!owner.deploy) throw new Error(`${ownerId} declares nothing to deploy`);
  const checkout = expandHome(owner.deploy.checkout);
  if ((await git(checkout, ['status', '--porcelain', '--untracked-files=no'])).trim()) return { outcome: 'failed', summary: `${checkout} has local changes; refusing to ship over them.` };
  const previous = (await git(checkout, ['rev-parse', 'HEAD'])).trim();
  await git(checkout, ['fetch', '-q', 'origin']);
  const target = (await git(checkout, ['rev-parse', `origin/${owner.domain.baseBranch}`])).trim();
  if (target === previous) return { outcome: 'nothing-to-ship', summary: `Already running ${previous.slice(0, 12)}.` };
  await git(checkout, ['merge', '-q', '--ff-only', `origin/${owner.domain.baseBranch}`]).catch(() => {
    throw new Error(`${checkout} cannot fast-forward to origin/${owner.domain.baseBranch}; a person should look`);
  });
  for (const [command, ...args] of [['npm', 'ci', '--no-audit', '--no-fund'], ['npm', 'run', 'verify']]) {
    const result = await runSandboxed(command!, args, { cwd: checkout, writable: [checkout] });
    if (result.exitCode !== 0) {
      await git(checkout, ['reset', '-q', '--hard', previous]);
      await runSandboxed('npm', ['ci', '--no-audit', '--no-fund'], { cwd: checkout, writable: [checkout] });
      return { outcome: 'failed', summary: `${command} ${args.join(' ')} failed; rolled back to ${previous.slice(0, 12)}.\n${result.output.slice(-800)}` };
    }
  }
  const scripts = join(runtime.stateDirectory, 'ship');
  await mkdir(scripts, { recursive: true });
  const script = join(scripts, `watchdog-${target.slice(0, 12)}.sh`);
  const journal = join(runtime.notebook(owner.id).directory, 'journal', `${new Date().toISOString().slice(0, 10)}.jsonl`);
  await writeFile(script, watchdogScript(owner.id, checkout, previous, owner.deploy.services, journal));
  await chmod(script, 0o755);
  await run('systemd-run', ['--user', '--quiet', `--on-active=${SHIP_LIMITS.restartDelaySeconds}`, `--unit=onionsoup-ship-${target.slice(0, 12)}`, '/bin/sh', script]);
  const notebook = runtime.notebook(owner.id);
  await notebook.journal({ kind: 'ship-started', note: `${previous.slice(0, 12)} → ${target.slice(0, 12)}; restarting ${owner.deploy.services.join(', ')} in ${SHIP_LIMITS.restartDelaySeconds}s` });
  await notebook.commit('journal ship').catch(() => undefined);
  const surface = owner.deploy.services.includes('onionsoup-surface.service') ? '' : ' The surface\'s opencode loads the plugin: the person restarts onionsoup-surface to pick up plugin changes.';
  return { outcome: 'shipped', summary: `Verified ${target.slice(0, 12)}; restarting ${owner.deploy.services.join(', ')} with a health check and automatic rollback.${surface}`, from: previous, to: target };
}
