import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Runtime } from '../packages/owners/src/runtime.ts';
import { readMaintenanceQuarantine } from '../packages/owners/src/maintenance-quarantine.ts';
import { hash } from './admission-recovery-proof.mjs';

export const OLD = 'b'.repeat(40);
export const NEXT = 'a'.repeat(40);
export const OWNERS = 'onionsoup-owners.service';
export const SURFACE = 'onionsoup-surface.service';

async function processStart(pid) {
  const contents = await readFile(`/proc/${pid}/stat`, 'utf8');
  return contents.slice(contents.lastIndexOf(') ') + 2).split(' ')[19];
}

async function startFixtureProcess() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  return { child, pid: child.pid, startTime: await processStart(child.pid),
    async stop() { child.kill('SIGTERM'); await exited; } };
}

export async function fixture(context, options = {}) {
  const scratch = await mkdtemp(join(tmpdir(), 'maintenance-recovery-'));
  const root = join(scratch, 'release');
  const state = join(scratch, 'state');
  const config = join(scratch, 'config');
  const workspace = join(scratch, 'workspace');
  await cp(resolve('packages/owners/test/fixtures/owners'), config, { recursive: true });
  await mkdir(workspace);
  await writeFile(join(workspace, 'source.txt'), 'unchanged source\n');
  const runtime = await Runtime.open({ state, declarations: config });
  const processes = [];
  context.after(async () => {
    await Promise.all(processes.map(process => process.stop()));
    runtime.close();
    await rm(scratch, { recursive: true, force: true });
  });
  for (const buildId of [OLD, NEXT]) {
    const directory = join(root, 'releases', buildId, 'packages/surface');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'release-manifest.json'), JSON.stringify({ buildId,
      ...(buildId === NEXT ? { capabilities: { legacyMaintenanceQuarantine: 1, ...options.capabilities } } : {}) }));
  }
  await symlink(join(root, 'releases', OLD), join(root, 'current'));
  const deploy = join(state, 'deploy');
  await mkdir(join(deploy, 'leases'), { recursive: true });
  await writeFile(join(deploy, 'pending.json'), JSON.stringify({ status: 'armed', targetBuildId: NEXT }));
  const owners = await startFixtureProcess();
  const surface = await startFixtureProcess();
  const opencode = await startFixtureProcess();
  processes.push(owners, surface, opencode);
  const endpoint = { instanceId: randomUUID(), surfacePid: surface.pid, surfaceStartTime: surface.startTime,
    opencodePid: opencode.pid, opencodeStartTime: opencode.startTime, url: 'http://127.0.0.1:14567/',
    username: 'fixture-user', password: 'fixture-private-credential' };
  const units = new Map([[OWNERS, [owners]], [SURFACE, [surface, opencode]]]);
  const identity = { bootID: randomUUID(), pidNamespace: 'pid:[4026531836]', units: [...units].map(([unit, members], index) => ({
    unit, invocationID: randomUUID().replaceAll('-', ''), mainPID: members[0].pid,
    controlGroup: `/fixture/${unit}`, cgroupInode: String(100 + index),
    processes: members.map(({ pid, startTime }) => ({ pid, startTime })),
  })) };
  const leases = [];
  const leasePaths = [];
  for (const kind of ['plugin:notices', 'plugin:operator-jobs']) {
    const lease = { id: randomUUID(), kind, pid: opencode.pid, startTime: opencode.startTime };
    leases.push(lease.id);
    const path = join(deploy, 'leases', `${lease.id}.json`);
    leasePaths.push(path);
    await writeFile(path, JSON.stringify(lease));
  }
  const activity = { busy: false, permission: false, question: false, independent: false,
    afterDrain: undefined, beforeService: undefined, healthFailure: false, unitState: undefined };
  const calls = [];
  const replacements = new Map();
  async function inspectUnit(_proof, unit) {
    if (activity.unitState) return activity.unitState;
    for (const process of units.get(unit)) {
      if (await processStart(process.pid).then(start => start === process.startTime, () => false)) return 'original';
    }
    return 'stopped';
  }
  const launchUnits = [OWNERS, SURFACE].map(unit => ({ unit, configurationDigest: hash('fixture'),
    files: [{ path: `/fixture/${unit}`, digest: hash('unit') }] }));
  const launch = { units: launchUnits, digest: hash(launchUnits) };
  const input = { root, state, config, evidenceRoots: [workspace], surfaceUrl: 'http://127.0.0.1:14568/',
    expectedOld: OLD, expectedTarget: NEXT, leases: leases.sort(), approvedBy: 'fixture-person',
    limits: { readinessMs: 0, readinessIntervalMs: 1 },
    effects: {
      inspectUnit,
      systemctl: async (action, unit) => {
        if (action === 'is-active') return true;
        calls.push({ action, unit });
        assert.equal((await pending()).status, 'draining');
        const marker = await readMaintenanceQuarantine(state);
        assert.equal(marker.targetBuildId, NEXT);
        assert.equal(JSON.parse(await readFile(join(deploy, 'rollback.json'))).recovery, 'legacy-maintenance');
        await activity.beforeService?.(action, unit);
        if (action === 'stop') await Promise.all(units.get(unit).map(process => process.stop()));
        if (action === 'start') {
          const members = await Promise.all(units.get(unit).map(() => startFixtureProcess()));
          processes.push(...members);
          replacements.set(unit, members);
        }
        assert.ok(['stop', 'start'].includes(action), 'recovery must never restart an old runtime');
        return true;
      },
      health: async (buildId, quarantine) => {
        if (activity.healthFailure) throw new Error('fixture-health-failed');
        assert.ok([OLD, NEXT].includes(buildId));
        if (buildId === NEXT) {
          if (replacements.size !== 2) throw new Error('fixture-target-not-started');
          for (const members of replacements.values()) {
            for (const process of members) assert.equal(await processStart(process.pid), process.startTime);
          }
          assert.equal(await readlink(join(root, 'current')), join(root, 'releases', NEXT));
          const marker = await readMaintenanceQuarantine(state);
          assert.equal(marker.targetBuildId, NEXT);
          if (quarantine) assert.equal(quarantine.digest, marker.digest);
        }
      },
    },
    probeEffects: {
      endpoint: async () => endpoint,
      storageRoots: async () => [workspace],
      launchConfiguration: async () => structuredClone(launch),
      runtimeIdentity: async () => structuredClone(identity),
      inspectUnit,
      processes: async () => activity.independent,
      sleep: async () => {
        if ((await pending()).status === 'draining') await activity.afterDrain?.();
      },
      request: async (_endpoint, path) => {
        if (path === '/session/status') return activity.busy ? { ses_busy: { type: 'busy' } } : {};
        if (path === '/permission') return activity.permission ? [{ id: 'permission' }] : [];
        if (path === '/question') return activity.question ? [{ id: 'question' }] : [];
        if (path.startsWith('/experimental/session') || path === '/session') return [];
        throw new Error(`unexpected fixture request: ${path}`);
      },
    },
  };
  async function pending() { return JSON.parse(await readFile(join(deploy, 'pending.json'), 'utf8')); }
  return { input, scratch, root, state, config, workspace, runtime, deploy, endpoint, identity,
    activity, calls, leasePaths, pending, units, replacements, launch, inspectUnit };
}

