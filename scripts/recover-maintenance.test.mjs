import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Runtime } from '../packages/owners/src/runtime.ts';
import { beginAdmission, listAdmissions } from '../packages/owners/src/deployment-admission.ts';
import { readMaintenanceQuarantine, maintenanceQuarantineDigest } from '../packages/owners/src/maintenance-quarantine.ts';
import { hash } from './admission-recovery-proof.mjs';
import { recoverMaintenance } from './recover-maintenance.mjs';
import { backupMaintenanceEvidence } from './maintenance-recovery-storage.mjs';
import { worker, arm } from './deploy-release.mjs';

const OLD = 'b'.repeat(40);
const NEXT = 'a'.repeat(40);
const OWNERS = 'onionsoup-owners.service';
const SURFACE = 'onionsoup-surface.service';

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

async function fixture(context) {
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
      ...(buildId === NEXT ? { capabilities: { legacyMaintenanceQuarantine: 1 } } : {}) }));
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

async function approve(fixture) {
  const preview = await recoverMaintenance(fixture.input);
  return { preview, input: { ...fixture.input, approveDigest: preview.digest } };
}

async function savedHistory(fixture) {
  return Promise.all([...fixture.leasePaths, join(fixture.workspace, 'source.txt')].map(path => readFile(path, 'utf8')));
}

async function assertHeld(fixture) {
  assert.equal((await fixture.pending()).status, 'draining');
  assert.equal((await readMaintenanceQuarantine(fixture.state)).targetBuildId, NEXT);
  assert.equal(JSON.parse(await readFile(join(fixture.deploy, 'rollback.json'))).recovery, 'legacy-maintenance');
  await assert.rejects(beginAdmission(fixture.state, 'fixture:new-work'), /maintenance_quarantined/);
}

test('preview binds exact legacy selection and backup evidence without interrupting either disposable process', async context => {
  const state = await fixture(context);
  const history = await savedHistory(state);
  const preview = await recoverMaintenance(state.input);
  assert.equal(preview.state, 'preview');
  assert.match(preview.digest, /^[a-f0-9]{64}$/);
  assert.equal(state.calls.length, 0);
  assert.equal((await state.pending()).status, 'armed');
  assert.deepEqual(await savedHistory(state), history);
  assert.equal((await listAdmissions(state.state)).filter(lease => lease.alive).length, 2);
  assert.doesNotMatch(JSON.stringify(preview), /fixture-private-credential|unchanged source/);
  await assert.rejects(readFile(join(state.deploy, 'rollback.json')), { code: 'ENOENT' });
});

test('approved interruption stops exact processes once, preserves unknown history, and starts only quarantined target', async context => {
  const state = await fixture(context);
  const history = await savedHistory(state);
  const { input } = await approve(state);
  const [receipt, duplicate] = await Promise.all([recoverMaintenance(input), recoverMaintenance(input)]);
  assert.deepEqual(duplicate, receipt);
  assert.equal(receipt.state, 'restored-quarantined');
  assert.equal(receipt.outcome, 'unknown');
  assert.deepEqual(state.calls, [
    { action: 'stop', unit: OWNERS }, { action: 'stop', unit: SURFACE },
    { action: 'start', unit: OWNERS }, { action: 'start', unit: SURFACE },
  ]);
  assert.deepEqual(await recoverMaintenance(input), receipt);
  assert.deepEqual(await savedHistory(state), history);
  assert.equal((await listAdmissions(state.state)).filter(lease => lease.alive).length, 0);
  assert.equal((await listAdmissions(state.state)).length, 2);
  await assertHeld(state);
  const attempts = await readdir(join(state.root, 'maintenance-recoveries', input.approveDigest, 'actions'));
  assert.equal(attempts.length, 5);
  assert.equal(JSON.parse(await readFile(join(state.deploy, 'maintenance-recoveries', `${input.approveDigest}.json`))).outcome, 'unknown');
});

for (const activity of ['busy', 'permission', 'question', 'independent']) {
  test(`${activity} blocks interruption and leaves both fixture processes running`, async context => {
    const state = await fixture(context);
    state.activity[activity] = true;
    await assert.rejects(recoverMaintenance(state.input));
    assert.equal(state.calls.length, 0);
    assert.equal((await state.pending()).status, 'armed');
    assert.equal((await listAdmissions(state.state)).filter(lease => lease.alive).length, 2);
  });
}

for (const change of ['source', 'lease', 'process', 'manifest', 'selection']) {
  test(`${change} change invalidates the approved digest before any service action`, async context => {
    const state = await fixture(context);
    const { input } = await approve(state);
    const changes = {
      source: () => writeFile(join(state.workspace, 'source.txt'), 'concurrent editor\n'),
      lease: async () => {
        const lease = JSON.parse(await readFile(state.leasePaths[0]));
        await writeFile(state.leasePaths[0], JSON.stringify({ ...lease, kind: 'plugin:changed' }));
      },
      process: () => { state.identity.units[0].invocationID = 'f'.repeat(32); },
      manifest: () => writeFile(join(state.root, 'releases', NEXT, 'packages/surface/release-manifest.json'), JSON.stringify({
        buildId: NEXT, capabilities: { legacyMaintenanceQuarantine: 1 }, changed: true,
      })),
      selection: () => { input.leases = input.leases.slice(1); },
    };
    await changes[change]();
    await assert.rejects(recoverMaintenance(input));
    assert.equal(state.calls.length, 0);
    assert.equal((await state.pending()).status, 'armed');
  });
}

test('new activity after drain refuses interruption before checkpoint', async context => {
  const state = await fixture(context);
  const { input } = await approve(state);
  state.activity.afterDrain = () => { state.activity.question = true; };
  await assert.rejects(recoverMaintenance(input));
  assert.equal(state.calls.length, 0);
  assert.equal((await state.pending()).status, 'waiting');
  await assert.rejects(readFile(join(state.deploy, 'rollback.json')), { code: 'ENOENT' });
});

test('uncertain stop records one attempt, retains protection, and refuses to repeat it on restart', async context => {
  const state = await fixture(context);
  const { input } = await approve(state);
  state.activity.beforeService = () => { throw new Error('fixture-stop-transport-uncertain'); };
  await assert.rejects(recoverMaintenance(input));
  await assertHeld(state);
  state.activity.beforeService = undefined;
  await assert.rejects(recoverMaintenance(input));
  assert.deepEqual(state.calls, [{ action: 'stop', unit: OWNERS }]);
  assert.equal(await readlink(join(state.root, 'current')), join(state.root, 'releases', OLD));
  assert.equal((await listAdmissions(state.state)).filter(lease => lease.alive).length, 2);
});

test('a stop with lost reply resumes only after independent exact process disappearance', async context => {
  const state = await fixture(context);
  const { input } = await approve(state);
  state.activity.beforeService = async (action, unit) => {
    if (action === 'stop' && unit === OWNERS) {
      await Promise.all(state.units.get(unit).map(process => process.stop()));
      throw new Error('fixture-reply-lost');
    }
  };
  await assert.rejects(recoverMaintenance(input));
  state.activity.beforeService = undefined;
  assert.equal((await recoverMaintenance(input)).state, 'restored-quarantined');
  assert.equal(state.calls.filter(call => call.action === 'stop' && call.unit === OWNERS).length, 1);
  await assertHeld(state);
});

for (const uncertain of ['foreign', 'unavailable']) {
  test(`${uncertain} process evidence after a stop attempt prevents switch and all further service actions`, async context => {
    const state = await fixture(context);
    const { input } = await approve(state);
    state.activity.beforeService = () => { throw new Error('fixture-transport-uncertain'); };
    await assert.rejects(recoverMaintenance(input));
    state.activity.unitState = uncertain;
    state.activity.beforeService = undefined;
    await assert.rejects(recoverMaintenance(input));
    assert.equal(state.calls.length, 1);
    assert.equal(await readlink(join(state.root, 'current')), join(state.root, 'releases', OLD));
    await assertHeld(state);
  });
}

test('target health failure holds quarantine and never rolls back or restarts unprotected old build', async context => {
  const state = await fixture(context);
  const { input } = await approve(state);
  state.activity.beforeService = action => { if (action === 'start') state.activity.healthFailure = true; };
  await assert.rejects(recoverMaintenance(input));
  const attempts = [...state.calls];
  await assert.rejects(recoverMaintenance(input));
  assert.deepEqual(state.calls, attempts);
  assert.equal(await readlink(join(state.root, 'current')), join(state.root, 'releases', NEXT));
  await assertHeld(state);
  state.activity.healthFailure = false;
  assert.equal((await recoverMaintenance(input)).state, 'restored-quarantined');
  assert.deepEqual(state.calls, attempts);
});

test('retained marker fences ordinary release worker and arm even if pending status is changed', async context => {
  const state = await fixture(context);
  const { input } = await approve(state);
  await recoverMaintenance(input);
  const marker = await readFile(join(state.deploy, 'rollback.json'), 'utf8');
  for (const status of ['draining', 'completed', 'cancelled']) {
    await writeFile(join(state.deploy, 'pending.json'), JSON.stringify({ status, targetBuildId: NEXT }));
    await assert.rejects(worker(state.input));
    await assert.rejects(arm({ ...state.input, source: state.workspace, commit: 'c'.repeat(40) }));
    assert.equal(await readFile(join(state.deploy, 'rollback.json'), 'utf8'), marker);
  }
  assert.equal(state.calls.length, 4);
});

test('both verified backup snapshots preserve lease and source bytes before any replacement starts', async context => {
  const state = await fixture(context);
  const history = await savedHistory(state);
  const { input } = await approve(state);
  state.activity.beforeService = async action => {
    const phases = action === 'stop' ? ['before-stop'] : ['before-stop', 'after-stop'];
    for (const phase of phases) {
      const path = join(state.root, 'maintenance-recoveries', input.approveDigest, phase, 'backup.json');
      const backup = JSON.parse(await readFile(path));
      assert.equal(backup.proofDigest, input.approveDigest);
      for (const [index, original] of state.leasePaths.entries()) {
        const copy = backup.copies.find(copy => copy.source === state.state);
        assert.equal(await readFile(join(copy.destination, 'deploy/leases', original.split('/').at(-1)), 'utf8'), history[index]);
      }
      const copy = backup.copies.find(copy => copy.source === state.workspace);
      assert.equal(await readFile(join(copy.destination, 'source.txt'), 'utf8'), history.at(-1));
    }
  };
  await recoverMaintenance(input);
});

test('uncertain target start is never reissued and cannot produce a restored receipt from partial health', async context => {
  const state = await fixture(context);
  const { input } = await approve(state);
  state.activity.beforeService = (action, unit) => {
    if (action === 'start' && unit === OWNERS) throw new Error('fixture-start-uncertain');
  };
  await assert.rejects(recoverMaintenance(input), /fixture-start-uncertain/);
  state.activity.beforeService = undefined;
  await assert.rejects(recoverMaintenance(input), /fixture-target-not-started/);
  const attempts = [...state.calls];
  await assert.rejects(recoverMaintenance(input), /fixture-target-not-started/);
  assert.deepEqual(state.calls, attempts);
  assert.equal(state.calls.filter(call => call.action === 'start' && call.unit === OWNERS).length, 1);
  assert.equal(await readlink(join(state.root, 'current')), join(state.root, 'releases', NEXT));
  await assertHeld(state);
  await assert.rejects(readFile(join(state.deploy, 'maintenance-recoveries', `${input.approveDigest}.json`)), { code: 'ENOENT' });
});

test('receipt persistence failure keeps one-time action journal and resumes without another service action', async context => {
  const state = await fixture(context);
  const { input } = await approve(state);
  const receiptDirectory = join(state.deploy, 'maintenance-recoveries');
  state.activity.beforeService = async (action, unit) => {
    if (action === 'start' && unit === SURFACE) await writeFile(receiptDirectory, 'fixture-storage-obstruction');
  };
  await assert.rejects(recoverMaintenance(input));
  await assertHeld(state);
  const attempts = [...state.calls];
  assert.equal(attempts.length, 4);
  await rm(receiptDirectory);
  const receipt = await recoverMaintenance(input);
  assert.equal(receipt.state, 'restored-quarantined');
  assert.deepEqual(state.calls, attempts);
});

for (const change of ['quarantine', 'drain', 'checkpoint', 'attempt']) {
  test(`changed ${change} on resume fails closed without another stop or start`, async context => {
    const state = await fixture(context);
    const { input } = await approve(state);
    state.activity.beforeService = () => { throw new Error('fixture-stop-uncertain'); };
    await assert.rejects(recoverMaintenance(input));
    state.activity.beforeService = undefined;
    const changes = {
      quarantine: () => writeFile(join(state.deploy, 'maintenance-quarantine.json'), '{}'),
      drain: () => writeFile(join(state.deploy, 'pending.json'), JSON.stringify({ status: 'armed', targetBuildId: NEXT })),
      checkpoint: () => writeFile(join(state.deploy, 'rollback.json'), '{"version":1}'),
      attempt: () => writeFile(join(state.root, 'maintenance-recoveries', input.approveDigest, 'actions', `stop-${OWNERS}.json`), '{}'),
    };
    await changes[change]();
    await assert.rejects(recoverMaintenance(input));
    assert.deepEqual(state.calls, [{ action: 'stop', unit: OWNERS }]);
  });
}

test('approval identity is mandatory and unrelated partial checkpoint is preserved byte for byte', async context => {
  const state = await fixture(context);
  const { input } = await approve(state);
  await assert.rejects(recoverMaintenance({ ...input, approvedBy: '' }), /maintenance_recovery_approver_required/);
  const partial = '{"recovery":"other-recovery","partial":';
  await writeFile(join(state.deploy, 'rollback.json'), partial);
  await assert.rejects(recoverMaintenance(input));
  assert.equal(await readFile(join(state.deploy, 'rollback.json'), 'utf8'), partial);
  assert.equal(state.calls.length, 0);
});

test('pointer changing after first target start prevents the second service from launching an old build', async context => {
  const state = await fixture(context);
  const { input } = await approve(state);
  state.activity.beforeService = async (action, unit) => {
    if (action === 'start' && unit === OWNERS) {
      await rm(join(state.root, 'current'));
      await symlink(join(state.root, 'releases', OLD), join(state.root, 'current'));
    }
  };
  await assert.rejects(recoverMaintenance(input), /maintenance_recovery_pointer_changed/);
  assert.deepEqual(state.calls, [
    { action: 'stop', unit: OWNERS }, { action: 'stop', unit: SURFACE }, { action: 'start', unit: OWNERS },
  ]);
  await assertHeld(state);
});

test('a completed receipt cannot claim a restored target after the current pointer changes', async context => {
  const state = await fixture(context);
  const { input } = await approve(state);
  await recoverMaintenance(input);
  const attempts = [...state.calls];
  await rm(join(state.root, 'current'));
  await symlink(join(state.root, 'releases', OLD), join(state.root, 'current'));
  await assert.rejects(recoverMaintenance(input), /maintenance_recovery_pointer_changed/);
  assert.deepEqual(state.calls, attempts);
});

for (const action of ['missing', 'different']) {
  test(`${action} positive stopped receipt cannot authorize a retry after the pointer switched`, async context => {
    const state = await fixture(context);
    const { input } = await approve(state);
    state.activity.beforeService = (action, unit) => {
      if (action === 'start' && unit === OWNERS) throw new Error('fixture-start-uncertain');
    };
    await assert.rejects(recoverMaintenance(input));
    const stoppedPath = join(state.root, 'maintenance-recoveries', input.approveDigest, 'stopped.json');
    if (action === 'missing') await rm(stoppedPath);
    else {
      const stopped = JSON.parse(await readFile(stoppedPath));
      await writeFile(stoppedPath, JSON.stringify({ ...stopped, action: 'start-onionsoup-owners.service' }));
    }
    state.activity.beforeService = undefined;
    await assert.rejects(recoverMaintenance(input), /maintenance_recovery_switch_unverified/);
    assert.equal(state.calls.length, 3);
  });
}

test('backup reuse verifies copies after interruption instead of accepting an existing receipt alone', async context => {
  const state = await fixture(context);
  const { preview, input } = await approve(state);
  await recoverMaintenance(input);
  const directory = join(state.root, 'maintenance-recoveries', input.approveDigest, 'after-stop');
  const receipt = JSON.parse(await readFile(join(directory, 'backup.json')));
  assert.deepEqual(await backupMaintenanceEvidence(preview.proof, directory, false), receipt);
  const copy = receipt.copies.find(copy => copy.source === state.workspace);
  await writeFile(join(copy.destination, 'source.txt'), 'corrupted archive\n');
  await assert.rejects(backupMaintenanceEvidence(preview.proof, directory, false), /maintenance_recovery_backup/);
});

test('changed approved launch configuration blocks interruption', async context => {
  const state = await fixture(context);
  const { input } = await approve(state);
  state.launch.units[0].configurationDigest = hash('changed command');
  state.launch.digest = hash(state.launch.units);
  await assert.rejects(recoverMaintenance(input));
  assert.equal(state.calls.length, 0);
});

test('new activity after a checkpoint with no attempted stop blocks resumed interruption', async context => {
  const state = await fixture(context);
  const { input } = await approve(state);
  state.activity.unitState = 'unavailable';
  await assert.rejects(recoverMaintenance(input));
  assert.equal(state.calls.length, 0);
  await assertHeld(state);
  state.activity.unitState = undefined;
  state.activity.busy = true;
  await assert.rejects(recoverMaintenance(input), /maintenance_recovery_active_runtime/);
  assert.equal(state.calls.length, 0);
});

test('new activity after owners stop prevents interruption of the still-live surface', async context => {
  const state = await fixture(context);
  const { input } = await approve(state);
  state.activity.beforeService = (action, unit) => {
    if (action === 'stop' && unit === OWNERS) state.activity.question = true;
  };
  await assert.rejects(recoverMaintenance(input), /maintenance_recovery_active_runtime/);
  assert.deepEqual(state.calls, [{ action: 'stop', unit: OWNERS }]);
  await assertHeld(state);
});

test('a self-consistent quarantine with changed admissions cannot replace the checkpoint-bound marker', async context => {
  const state = await fixture(context);
  const { input } = await approve(state);
  state.activity.unitState = 'unavailable';
  await assert.rejects(recoverMaintenance(input));
  const path = join(state.deploy, 'maintenance-quarantine.json');
  const { digest: _digest, ...body } = JSON.parse(await readFile(path));
  body.admissions[0].kind = 'plugin:forged';
  await writeFile(path, JSON.stringify({ ...body, digest: maintenanceQuarantineDigest(body) }));
  state.activity.unitState = undefined;
  await assert.rejects(recoverMaintenance(input), /maintenance_recovery_quarantine_changed/);
  assert.equal(state.calls.length, 0);
});

test('new busy activity in final preflight leaves no stop-attempt record and remains retryable', async context => {
  const state = await fixture(context);
  const { input } = await approve(state);
  const inspect = input.probeEffects.inspectUnit;
  let surfaceObservations = 0;
  input.probeEffects.inspectUnit = async (identity, unit) => {
    const observed = await inspect(identity, unit);
    if (unit === SURFACE) {
      // The original surface is sampled at entry and exit of the first full preflight.
      // New activity begins after that first verified read, before final preflight.
      surfaceObservations++;
      if (surfaceObservations === 2) state.activity.busy = true;
    }
    return observed;
  };
  await assert.rejects(recoverMaintenance(input), /maintenance_recovery_active_runtime/);
  assert.equal(state.calls.length, 0);
  const attempt = join(state.root, 'maintenance-recoveries', input.approveDigest, 'actions', `stop-${OWNERS}.json`);
  await assert.rejects(readFile(attempt), { code: 'ENOENT' });
  await assertHeld(state);
  input.probeEffects.inspectUnit = inspect;
  state.activity.busy = false;
  assert.equal((await recoverMaintenance(input)).state, 'restored-quarantined');
  assert.equal(state.calls.length, 4);
});

async function interruptedSwitch(context, withStartAttempt = false) {
  const state = await fixture(context);
  const { input } = await approve(state);
  state.activity.beforeService = async (action, unit) => {
    if (action === 'stop' && unit === SURFACE) {
      await Promise.all(state.units.get(unit).map(process => process.stop()));
      throw new Error('fixture-stopped-reply-lost');
    }
  };
  await assert.rejects(recoverMaintenance(input), /fixture-stopped-reply-lost/);
  state.activity.beforeService = undefined;
  assert.equal(await state.inspectUnit(undefined, OWNERS), 'stopped');
  assert.equal(await state.inspectUnit(undefined, SURFACE), 'stopped');
  const directory = join(state.root, 'maintenance-recoveries', input.approveDigest, 'actions');
  const switchPath = join(directory, 'switch.json');
  const saved = JSON.stringify({ version: 1, digest: input.approveDigest, action: 'switch', at: new Date().toISOString() });
  await writeFile(switchPath, saved, { flag: 'wx' });
  if (withStartAttempt) {
    await writeFile(join(directory, `start-${OWNERS}.json`), JSON.stringify({ version: 1,
      digest: input.approveDigest, action: `start-${OWNERS}`, at: new Date().toISOString() }), { flag: 'wx' });
  }
  return { state, input, switchPath, saved };
}

test('interrupted pointer intent can resume only with old pointer, stopped processes and no start attempts', async context => {
  const { state, input, switchPath, saved } = await interruptedSwitch(context);
  assert.equal(await readlink(join(state.root, 'current')), join(state.root, 'releases', OLD));
  const receipt = await recoverMaintenance(input);
  assert.equal(receipt.state, 'restored-quarantined');
  assert.equal(await readlink(join(state.root, 'current')), join(state.root, 'releases', NEXT));
  assert.equal(await readFile(switchPath, 'utf8'), saved);
  assert.deepEqual(state.calls, [
    { action: 'stop', unit: OWNERS }, { action: 'stop', unit: SURFACE },
    { action: 'start', unit: OWNERS }, { action: 'start', unit: SURFACE },
  ]);
  assert.deepEqual(await recoverMaintenance(input), receipt);
  assert.equal(state.calls.length, 4);
});

test('a recorded target start with an old pointer blocks interrupted-switch retry without new effects', async context => {
  const { state, input, switchPath, saved } = await interruptedSwitch(context, true);
  await assert.rejects(recoverMaintenance(input), /maintenance_recovery_switch/);
  assert.equal(await readlink(join(state.root, 'current')), join(state.root, 'releases', OLD));
  assert.equal(await readFile(switchPath, 'utf8'), saved);
  assert.deepEqual(state.calls, [{ action: 'stop', unit: OWNERS }, { action: 'stop', unit: SURFACE }]);
  await assertHeld(state);
});
