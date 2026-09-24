import { execFile } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RepositoryOwner } from './declarations.ts';
import type { Runtime } from './runtime.ts';
import { runSandboxed, sandboxCommand, privateXdgRoots } from './sandbox.ts';
import { expandHome } from './truenas.ts';
import { git } from './workspace.ts';

const run = promisify(execFile);

export const SHIP_LIMITS = { restartDelaySeconds: 5, healthWaitSeconds: 45, failureOutputChars: 800 };
const INSTALL = ['npm', 'ci', '--no-audit', '--no-fund'];
const ROLLBACK_COMMANDS = [INSTALL, ['npm', 'run', 'build'], ['npm', 'run', 'surface:build']];

export interface ShipResult {
  outcome: 'shipped' | 'nothing-to-ship' | 'failed';
  summary: string;
  from?: string;
  to?: string;
}

/** External process seams; filesystem, Git history, and rollback scripts remain real in tests. */
export interface ShipExecution {
  sandbox: typeof runSandboxed;
  schedule: (script: string, target: string) => Promise<unknown>;
}

const EXECUTION: ShipExecution = {
  sandbox: runSandboxed,
  schedule: (script, target) => run('systemd-run', [
    '--user', '--quiet', `--on-active=${SHIP_LIMITS.restartDelaySeconds}`,
    `--unit=onionsoup-ship-${target.slice(0, 12)}`, '/bin/sh', script,
  ]),
};

export function hasShipGrant(owner: RepositoryOwner) {
  return owner.grants.some(grant => grant.to === owner.id && grant.action === 'ship'
    && (grant.target === owner.domain.name || grant.target === '*'));
}

function shellArgument(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function rollbackCommands(checkout: string) {
  const { config, state } = privateXdgRoots();
  return ROLLBACK_COMMANDS.map(([command, ...args]) => [
    'env', `XDG_CONFIG_HOME=${config}`, `XDG_STATE_HOME=${state}`, `OPENCODE_CONFIG_DIR=${join(config, 'opencode')}`,
    'systemd-run', ...sandboxCommand(command!, args, { cwd: checkout, writable: [checkout] }),
  ].map(shellArgument).join(' ')).join(' &&\n');
}

/** A separate unit survives the daemon's restart and rebuilds the previous release before restarting it. */
function watchdogScript(ownerId: string, checkout: string, previous: string, services: readonly string[], journal: string) {
  const units = services.map(shellArgument).join(' ');
  const rollback = `cd ${shellArgument(checkout)} && git reset -q --hard ${shellArgument(previous)} &&\n${rollbackCommands(checkout)}`;
  return `#!/bin/sh
record() { printf '{"at":"%s","owner":"%s","kind":"%s","note":"%s"}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ${shellArgument(ownerId)} "$1" "$2" >> ${shellArgument(journal)}; }
healthy() {
  for unit in ${units}; do systemctl --user is-active --quiet "$unit" || return 1; done
}
systemctl --user restart ${units}
sleep ${SHIP_LIMITS.healthWaitSeconds}
if healthy; then record shipped "services healthy after restart"; exit 0; fi
record attention "ship failed health check; restoring ${previous.slice(0, 12)} and its build artifacts"
if ! systemctl --user stop ${units}; then
  record attention "ship_rollback_failed: could not stop services"
  exit 1
fi
if ! ( ${rollback} ); then
  record attention "ship_rollback_failed: reset, install or rebuild failed; services remain stopped"
  exit 1
fi
if ! systemctl --user restart ${units}; then
  record attention "ship_rollback_failed: restart failed"
  exit 1
fi
sleep ${SHIP_LIMITS.healthWaitSeconds}
if ! healthy; then
  record attention "ship_rollback_failed: previous release unhealthy"
  exit 1
fi
record ship-rolled-back "restored ${previous.slice(0, 12)} with rebuilt artifacts; services healthy"
`;
}

async function runCommands(checkout: string, commands: string[][], execution: ShipExecution) {
  for (const [command, ...args] of commands) {
    const completed = await execution.sandbox(command!, args, { cwd: checkout, writable: [checkout] });
    if (completed.exitCode !== 0) {
      throw new Error(`${command} ${args.join(' ')} failed: ${completed.output.slice(-SHIP_LIMITS.failureOutputChars)}`);
    }
  }
}

async function restoreRelease(checkout: string, previous: string, execution: ShipExecution) {
  await git(checkout, ['reset', '-q', '--hard', previous]);
  await runCommands(checkout, ROLLBACK_COMMANDS, execution);
}

async function recordFailure(runtime: Runtime, ownerId: string, summary: string) {
  const notebook = runtime.notebook(ownerId);
  await notebook.journal({ kind: 'attention', note: summary });
  await notebook.commit('journal failed ship').catch(() => undefined);
  return { outcome: 'failed' as const, summary };
}

async function failedShip(runtime: Runtime, ownerId: string, checkout: string, previous: string, error: unknown, execution: ShipExecution) {
  const reason = error instanceof Error ? error.message : String(error);
  try {
    await restoreRelease(checkout, previous, execution);
    return recordFailure(runtime, ownerId, `Ship failed; restored ${previous.slice(0, 12)} and rebuilt its artifacts.\n${reason}`);
  } catch (rollbackError) {
    const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
    return recordFailure(runtime, ownerId, `ship_rollback_failed: ${detail}\nOriginal ship failure: ${reason}`);
  }
}

async function scheduleRestart(runtime: Runtime, owner: RepositoryOwner, previous: string, target: string, execution: ShipExecution) {
  const scripts = join(runtime.stateDirectory, 'ship');
  await mkdir(scripts, { recursive: true });
  const script = join(scripts, `watchdog-${target.slice(0, 12)}.sh`);
  const notebook = runtime.notebook(owner.id);
  const journal = join(notebook.directory, 'journal', `${new Date().toISOString().slice(0, 10)}.jsonl`);
  await mkdir(join(notebook.directory, 'journal'), { recursive: true });
  await writeFile(script, watchdogScript(owner.id, expandHome(owner.deploy!.checkout), previous, owner.deploy!.services, journal));
  await chmod(script, 0o755);
  await execution.schedule(script, target);
  await notebook.journal({
    kind: 'ship-started',
    note: `${previous.slice(0, 12)} → ${target.slice(0, 12)}; restarting ${owner.deploy!.services.join(', ')} in ${SHIP_LIMITS.restartDelaySeconds}s`,
  });
  await notebook.commit('journal ship').catch(() => undefined);
}

/** Fast-forward, verify, and arrange a health-checked restart; both failure paths rebuild previous artifacts. */
export async function shipEngine(runtime: Runtime, ownerId: string, execution: ShipExecution = EXECUTION): Promise<ShipResult> {
  const owner = runtime.repositoryOwner(ownerId);
  if (!owner.deploy) throw new Error(`${ownerId} declares nothing to deploy`);
  const checkout = expandHome(owner.deploy.checkout);
  if ((await git(checkout, ['status', '--porcelain', '--untracked-files=no'])).trim()) {
    return { outcome: 'failed', summary: `${checkout} has local changes; refusing to ship over them.` };
  }
  const previous = (await git(checkout, ['rev-parse', 'HEAD'])).trim();
  await git(checkout, ['fetch', '-q', 'origin']);
  const target = (await git(checkout, ['rev-parse', `origin/${owner.domain.baseBranch}`])).trim();
  if (target === previous) return { outcome: 'nothing-to-ship', summary: `Already running ${previous.slice(0, 12)}.` };
  await git(checkout, ['merge', '-q', '--ff-only', `origin/${owner.domain.baseBranch}`]).catch(() => {
    throw new Error(`${checkout} cannot fast-forward to origin/${owner.domain.baseBranch}; a person should look`);
  });
  try {
    await runCommands(checkout, [INSTALL, ['npm', 'run', 'verify']], execution);
    await scheduleRestart(runtime, owner, previous, target, execution);
  } catch (error) {
    return failedShip(runtime, ownerId, checkout, previous, error, execution);
  }
  const surface = owner.deploy.services.includes('onionsoup-surface.service') ? ''
    : " The surface's opencode loads the plugin: the person restarts onionsoup-surface to pick up plugin changes.";
  return {
    outcome: 'shipped',
    summary: `Verified ${target.slice(0, 12)}; restarting ${owner.deploy.services.join(', ')} with a health check and automatic rollback.${surface}`,
    from: previous, to: target,
  };
}
