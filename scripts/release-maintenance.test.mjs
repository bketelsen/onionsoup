import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beginAdmission } from '../packages/owners/src/deployment-admission.ts';
import { readMaintenanceQuarantine } from '../packages/owners/src/maintenance-quarantine.ts';
import { maintenanceReleasePaths } from '../packages/owners/src/maintenance-release-state.ts';
import { recoverMaintenance } from './recover-maintenance.mjs';
import { fingerprintEvidence } from './maintenance-admission-probe.mjs';
import { releaseMaintenance } from './release-maintenance.mjs';
import { fixture, NEXT, OLD, OWNERS, SURFACE } from './maintenance-recovery-fixture.mjs';


function syntheticMessages(sessionID) {
  return [
    { info: { id: `${sessionID}-user`, sessionID, role: 'user' },
      parts: [{ type: 'text', text: 'Inspect synthetic fixture source.' }] },
    { info: { id: `${sessionID}-assistant`, sessionID, role: 'assistant', parentID: `${sessionID}-user`,
      finish: 'stop', time: { completed: 1 } }, parts: [{ type: 'text', text: 'Synthetic inspection completed.' }] },
  ];
}

function syntheticHistory(directory) {
  const sessions = [{ id: 'ses_fixture_parent', directory },
    { id: 'ses_fixture_child', directory, parentID: 'ses_fixture_parent' }];
  return { sessions, messages: Object.fromEntries(sessions.map(session => [session.id, syntheticMessages(session.id)])) };
}

function historyResponse(sessions, messages, path) {
  if (path.startsWith('/experimental/session') || path === '/session') return sessions;
  const match = /^\/session\/([^/]+)(?:\/(message|children))?$/.exec(path);
  if (!match || match[1] === 'status') return undefined;
  const id = decodeURIComponent(match[1]);
  if (match[2] === 'message') return messages[id];
  if (match[2] === 'children') return sessions.filter(session => session.parentID === id);
  return sessions.find(session => session.id === id);
}

async function recovered(context, options = {}) {
  const state = await fixture(context, { capabilities: { legacyMaintenanceRelease: 1 } });
  state.identity.bootID = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  state.identity.pidNamespace = await readlink('/proc/self/ns/pid');
  const previousManifest = process.env.ONIONSOUP_RELEASE_MANIFEST;
  process.env.ONIONSOUP_RELEASE_MANIFEST = join(state.root, 'releases', NEXT, 'packages/surface/release-manifest.json');
  context.after(() => {
    if (previousManifest === undefined) delete process.env.ONIONSOUP_RELEASE_MANIFEST;
    else process.env.ONIONSOUP_RELEASE_MANIFEST = previousManifest;
  });
  const history = options.history ? syntheticHistory(state.workspace) : undefined;
  if (history) {
    const request = state.input.probeEffects.request;
    state.input.probeEffects.request = async (endpoint, path) =>
      historyResponse(history.sessions, history.messages, path) ?? request(endpoint, path);
  }
  if (options.storageSubdirectories) {
    await mkdir(join(state.workspace, 'original-storage'));
    await mkdir(join(state.workspace, 'other-storage'));
    state.input.probeEffects.storageRoots = async () => [join(state.workspace, 'original-storage')];
  }
  const preview = await recoverMaintenance(state.input);
  const receipt = await recoverMaintenance({ ...state.input, approveDigest: preview.digest });
  const originalFiles = [...state.leasePaths, join(state.workspace, 'source.txt'),
    join(state.deploy, 'maintenance-recoveries', `${preview.digest}.json`)];
  const originals = await Promise.all(originalFiles.map(path => readFile(path, 'utf8')));
  const runtimeIdentity = structuredClone(state.identity);
  runtimeIdentity.units = runtimeIdentity.units.map(unit => ({ ...unit,
    invocationID: randomUUID().replaceAll('-', ''),
    mainPID: state.replacements.get(unit.unit)[0].pid,
    processes: state.replacements.get(unit.unit).map(({ pid, startTime }) => ({ pid, startTime })),
  }));
  const surface = state.replacements.get(SURFACE)[0];
  const opencode = state.replacements.get(SURFACE)[1];
  const endpoint = { ...state.endpoint, instanceId: randomUUID(), surfacePid: surface.pid,
    surfaceStartTime: surface.startTime, opencodePid: opencode.pid, opencodeStartTime: opencode.startTime };
  const activity = { acknowledgments: true, busy: false, sessions: structuredClone(history?.sessions ?? []),
    messages: structuredClone(history?.messages ?? {}), beforeRequest: undefined,
    disposed: false, disposals: 0, globalHealthReads: 0 };
  const probeEffects = { ...state.input.probeEffects,
    endpoint: async () => endpoint,
    globalHealth: async observed => {
      assert.equal(observed.instanceId, endpoint.instanceId);
      activity.globalHealthReads++;
      return { healthy: true };
    },
    disposeObservation: async observed => {
      assert.equal(observed.instanceId, endpoint.instanceId);
      activity.disposals++;
      assert.equal(activity.disposals, 1, 'disposal may not be repeated');
      activity.disposed = true;
      return true;
    },
    runtimeIdentity: async () => structuredClone(runtimeIdentity),
    diagnosticHealth: async () => {
      const marker = await readMaintenanceQuarantine(state.state);
      return { state: 'active', digest: marker.digest, recoveryDigest: marker.recoveryDigest,
        targetBuildId: NEXT, oldBuildId: OLD, buildId: NEXT, component: 'surface',
        pid: surface.pid, startTime: surface.startTime };
    },
    quarantineAcknowledgments: async () => {
      const marker = await readMaintenanceQuarantine(state.state);
      return ['daemon', 'surface'].map(component => {
        const process = state.replacements.get(component === 'daemon' ? OWNERS : SURFACE)[0];
        return { version: 1, component, digest: marker.digest, recoveryDigest: marker.recoveryDigest,
          buildId: NEXT, pid: process.pid, startTime: process.startTime, at: new Date().toISOString() };
      });
    },
    releaseAcknowledgments: async () => {
      if (!activity.acknowledgments) return [];
      const observation = JSON.parse(await readFile(maintenanceReleasePaths(state.state).observation));
      return ['daemon', 'surface', 'plugin'].map(component => {
        const process = component === 'daemon' ? state.replacements.get(OWNERS)[0]
          : component === 'surface' ? surface : opencode;
        return { ...observation, component, phase: 'observation', pid: process.pid,
          startTime: process.startTime, at: new Date().toISOString() };
      });
    },
    request: async (_endpoint, path) => {
      assert.equal(activity.disposed, false, 'directory reads after disposal would recreate restricted configuration');
      await activity.beforeRequest?.(path);
      if (path === '/session/status') return activity.busy ? { ses_active: { type: 'busy' } } : {};
      if (path === '/permission' || path === '/question') return [];
      const historical = historyResponse(activity.sessions, activity.messages, path);
      if (historical !== undefined) return historical;
      throw new Error(`unexpected release fixture request: ${path}`);
    },
  };
  const input = { root: state.root, state: state.state, recoveryDigest: preview.digest,
    approvedBy: 'fixture-person', probeEffects };
  async function assertHistory() {
    assert.deepEqual(await Promise.all(originalFiles.map(path => readFile(path, 'utf8'))), originals);
    assert.equal(receipt.outcome, 'unknown');
    assert.equal(state.calls.length, 4, 'release never repeats recovery stops or starts');
  }
  return { ...state, releaseInput: input, releaseActivity: activity, runtimeIdentity,
    recoveredReceipt: receipt, assertHistory };
}

async function observe(state) {
  const preview = await releaseMaintenance(state.releaseInput);
  const receipt = await releaseMaintenance({ ...state.releaseInput, beginObservationDigest: preview.digest });
  return { preview, receipt };
}

async function preparedRelease(state) {
  await observe(state);
  const input = { ...state.releaseInput, mode: 'release' };
  const preview = await releaseMaintenance(input);
  return { preview, input: { ...input, releaseDigest: preview.digest } };
}

async function assertQuarantined(state) {
  assert.equal((await readMaintenanceQuarantine(state.state)).targetBuildId, NEXT);
  await assert.rejects(beginAdmission(state.state, 'fixture:new-work'), /maintenance_quarantined/);
  await state.assertHistory();
}

test('observation preview leaves recovered unknown evidence and admission gate unchanged', async context => {
  const state = await recovered(context);
  const preview = await releaseMaintenance(state.releaseInput);
  assert.equal(preview.state, 'observation-preview');
  assert.match(preview.digest, /^[a-f0-9]{64}$/);
  await assert.rejects(readFile(maintenanceReleasePaths(state.state).observation), { code: 'ENOENT' });
  await assertQuarantined(state);
});

test('approved observation is durable and idempotent without repeating service actions', async context => {
  const state = await recovered(context);
  const preview = await releaseMaintenance(state.releaseInput);
  const input = { ...state.releaseInput, beginObservationDigest: preview.digest };
  const [first, duplicate] = await Promise.all([releaseMaintenance(input), releaseMaintenance(input)]);
  assert.deepEqual(duplicate, first);
  const saved = await readFile(maintenanceReleasePaths(state.state).observation, 'utf8');
  assert.equal(JSON.parse(saved).approvalDigest, preview.digest);
  await releaseMaintenance(input);
  assert.equal(await readFile(maintenanceReleasePaths(state.state).observation, 'utf8'), saved);
  await assertQuarantined(state);
});

test('a complete recovery and approved release admits new work while retaining unknown original history', async context => {
  const state = await recovered(context);
  const { preview, input } = await preparedRelease(state);
  assert.equal(preview.state, 'release-preview');
  assert.equal(preview.eligible, true);
  assert.deepEqual(preview.blockers, []);
  const [receipt, duplicate] = await Promise.all([releaseMaintenance(input), releaseMaintenance(input)]);
  assert.deepEqual(duplicate, receipt);
  assert.equal(receipt.state, 'released');
  assert.equal(state.releaseActivity.disposals, 1);
  assert.equal(await readMaintenanceQuarantine(state.state), undefined);
  assert.equal((await state.pending()).status, 'completed');
  const admission = await beginAdmission(state.state, 'fixture:new-work');
  await admission.release();
  await state.assertHistory();
});

for (const stage of ['observation', 'release']) {
  test(`${stage} requires an explicit approver and exact preview digest`, async context => {
    const state = await recovered(context);
    const preview = stage === 'release' ? (await preparedRelease(state)).preview
      : await releaseMaintenance(state.releaseInput);
    const key = stage === 'release' ? 'releaseDigest' : 'beginObservationDigest';
    const input = { ...state.releaseInput, mode: stage, [key]: preview.digest };
    await assert.rejects(releaseMaintenance({ ...input, approvedBy: '' }));
    await assert.rejects(releaseMaintenance({ ...input, [key]: 'f'.repeat(64) }));
    await assertQuarantined(state);
  });
}

for (const change of ['source', 'lease', 'pointer', 'manifest', 'drain', 'checkpoint', 'backup']) {
  test(`changed ${change} invalidates observation approval without weakening quarantine`, async context => {
    const state = await recovered(context);
    const preview = await releaseMaintenance(state.releaseInput);
    const changes = {
      source: () => writeFile(join(state.workspace, 'source.txt'), 'new user source\n'),
      lease: async () => {
        const lease = JSON.parse(await readFile(state.leasePaths[0]));
        await writeFile(state.leasePaths[0], JSON.stringify({ ...lease, kind: 'plugin:other' }));
      },
      pointer: async () => {
        await rm(join(state.root, 'current'));
        await symlink(join(state.root, 'releases', OLD), join(state.root, 'current'));
      },
      manifest: () => writeFile(join(state.root, 'releases', NEXT, 'packages/surface/release-manifest.json'), '{}'),
      drain: () => writeFile(join(state.deploy, 'pending.json'), JSON.stringify({ status: 'armed', targetBuildId: NEXT })),
      checkpoint: () => writeFile(join(state.deploy, 'rollback.json'), '{}'),
      backup: async () => {
        const directory = join(state.root, 'maintenance-recoveries', state.releaseInput.recoveryDigest, 'after-stop');
        const backup = JSON.parse(await readFile(join(directory, 'backup.json')));
        const copy = backup.copies.find(copy => copy.source === state.workspace);
        await writeFile(join(copy.destination, 'source.txt'), 'corrupt backup\n');
      },
    };
    await changes[change]();
    await assert.rejects(releaseMaintenance({ ...state.releaseInput, beginObservationDigest: preview.digest }));
    assert.equal((await readMaintenanceQuarantine(state.state)).targetBuildId, NEXT);
    await assert.rejects(readFile(maintenanceReleasePaths(state.state).observation), { code: 'ENOENT' });
    assert.equal(state.calls.length, 4);
  });
}

for (const change of ['source', 'process', 'acknowledgment', 'busy']) {
  test(`changed ${change} rejects final release evidence and preserves the unknown history`, async context => {
    const state = await recovered(context);
    const { input } = await preparedRelease(state);
    const changes = {
      source: () => writeFile(join(state.workspace, 'source.txt'), 'new user source\n'),
      process: () => { state.runtimeIdentity.units[0].invocationID = randomUUID().replaceAll('-', ''); },
      acknowledgment: () => { state.releaseActivity.acknowledgments = false; },
      busy: () => { state.releaseActivity.busy = true; },
    };
    await changes[change]();
    await assert.rejects(releaseMaintenance(input));
    assert.equal((await readMaintenanceQuarantine(state.state)).targetBuildId, NEXT);
    await assert.rejects(readFile(maintenanceReleasePaths(state.state).receipt), { code: 'ENOENT' });
    assert.equal(state.calls.length, 4);
  });
}

async function addPendingReminder(state) {
  await mkdir(join(state.state, 'reminders'), { recursive: true });
  const now = new Date().toISOString();
  const path = join(state.state, 'reminders', 'legacy-reminder.json');
  const bytes = JSON.stringify({ id: 'legacy-reminder', owner: 'operator', prompt: 'Inspect the disposable fixture',
    dueAt: now, status: 'pending', createdAt: now, updatedAt: now });
  await writeFile(path, bytes);
  return { path, bytes };
}

test('a legacy pending continuation with no submission proof is an explicit blocker, never invented completion', async context => {
  const state = await recovered(context);
  const reminder = await addPendingReminder(state);
  await observe(state);
  const preview = await releaseMaintenance({ ...state.releaseInput, mode: 'release' });
  assert.equal(preview.eligible, false);
  assert.ok(JSON.stringify(preview.blockers).includes('legacy_reminder_without_single_use_claim'));
  await assert.rejects(releaseMaintenance({ ...state.releaseInput, mode: 'release', releaseDigest: preview.digest }));
  assert.equal(await readFile(reminder.path, 'utf8'), reminder.bytes);
  await assertQuarantined(state);
});

test('a new continuation after approved preview cannot slip through final release', async context => {
  const state = await recovered(context);
  const { input } = await preparedRelease(state);
  const reminder = await addPendingReminder(state);
  await assert.rejects(releaseMaintenance(input));
  assert.equal(await readFile(reminder.path, 'utf8'), reminder.bytes);
  await assertQuarantined(state);
});

test('an unacknowledged observation bootstrap remains protected across retries without another launch', async context => {
  const state = await recovered(context);
  await observe(state);
  state.releaseActivity.acknowledgments = false;
  const input = { ...state.releaseInput, mode: 'release' };
  await assert.rejects(releaseMaintenance(input), /maintenance_release_ack_unverified/);
  await assert.rejects(releaseMaintenance(input), /maintenance_release_ack_unverified/);
  await assertQuarantined(state);
  state.releaseActivity.acknowledgments = true;
  assert.equal((await releaseMaintenance(input)).eligible, true);
});


test('an interrupted observation commit resumes the same archived approval without replacing history', async context => {
  const state = await recovered(context);
  const preview = await releaseMaintenance(state.releaseInput);
  let reads = 0;
  state.releaseInput.probeEffects.fingerprint = async (...args) => {
    reads++;
    if (reads === 3) throw new Error('fixture-local-proof-interrupted');
    return fingerprintEvidence(...args);
  };
  const input = { ...state.releaseInput, beginObservationDigest: preview.digest };
  await assert.rejects(releaseMaintenance(input), /fixture-local-proof-interrupted/);
  const approvalPath = join(state.root, 'maintenance-releases', preview.digest, 'observation-approval.json');
  const saved = await readFile(approvalPath, 'utf8');
  await assert.rejects(readFile(maintenanceReleasePaths(state.state).observation), { code: 'ENOENT' });
  delete state.releaseInput.probeEffects.fingerprint;
  await releaseMaintenance(input);
  assert.equal(await readFile(approvalPath, 'utf8'), saved);
  await assertQuarantined(state);
});

test('new work arriving between external proof and admission commit blocks release', async context => {
  const state = await recovered(context);
  const { input } = await preparedRelease(state);
  let reads = 0;
  let reminder;
  state.releaseInput.probeEffects.fingerprint = async (...args) => {
    const snapshot = await fingerprintEvidence(...args);
    reads++;
    if (reads === 2) reminder = await addPendingReminder(state);
    return snapshot;
  };
  await assert.rejects(releaseMaintenance(input), /maintenance_release_(inventory|evidence)_changed/);
  assert.equal(await readFile(reminder.path, 'utf8'), reminder.bytes);
  await assert.rejects(readFile(maintenanceReleasePaths(state.state).receipt), { code: 'ENOENT' });
  await assertQuarantined(state);
});

test('receipt storage failure after pending completion remains fenced and can resume the exact approved release', async context => {
  const state = await recovered(context);
  const { input } = await preparedRelease(state);
  let reads = 0;
  const receiptPath = maintenanceReleasePaths(state.state).receipt;
  state.releaseInput.probeEffects.fingerprint = async (...args) => {
    const snapshot = await fingerprintEvidence(...args);
    reads++;
    if (reads === 3) await mkdir(receiptPath);
    return snapshot;
  };
  await assert.rejects(releaseMaintenance(input));
  assert.equal((await state.pending()).status, 'completed');
  await assert.rejects(beginAdmission(state.state, 'fixture:new-work'));
  await rm(receiptPath, { recursive: true });
  delete state.releaseInput.probeEffects.fingerprint;
  const outcome = await releaseMaintenance(input);
  assert.equal(outcome.state, 'released');
  assert.equal(state.releaseActivity.disposals, 1);
  const admission = await beginAdmission(state.state, 'fixture:new-work');
  await admission.release();
  await state.assertHistory();
});

test('committed release cleanup can resume alongside new work, while an old binary stays fenced by the retained marker', async context => {
  const state = await recovered(context);
  const { input } = await preparedRelease(state);
  const observation = JSON.parse(await readFile(maintenanceReleasePaths(state.state).observation));
  const archiveReceipt = join(state.root, 'maintenance-releases', observation.approvalDigest, 'release-receipt.json');
  let reads = 0;
  state.releaseInput.probeEffects.fingerprint = async (...args) => {
    const snapshot = await fingerprintEvidence(...args);
    reads++;
    if (reads === 3) await mkdir(archiveReceipt);
    return snapshot;
  };
  await assert.rejects(releaseMaintenance(input));
  assert.equal((await state.pending()).status, 'completed');
  assert.equal((await readMaintenanceQuarantine(state.state)).targetBuildId, NEXT);
  assert.equal(JSON.parse(await readFile(maintenanceReleasePaths(state.state).receipt)).reconciliationDigest, input.releaseDigest);
  process.env.ONIONSOUP_RELEASE_MANIFEST = join(state.root, 'releases', OLD, 'packages/surface/release-manifest.json');
  await assert.rejects(beginAdmission(state.state, 'fixture:old-build'), /maintenance_release_binding_mismatch/);
  process.env.ONIONSOUP_RELEASE_MANIFEST = join(state.root, 'releases', NEXT, 'packages/surface/release-manifest.json');
  const admission = await beginAdmission(state.state, 'fixture:new-work');
  try {
    const activePath = join(state.deploy, 'leases', `${admission.id}.json`);
    const activeBytes = await readFile(activePath, 'utf8');
    await rm(archiveReceipt, { recursive: true });
    state.releaseInput.probeEffects.request = async () => { throw new Error('must-not-reconcile-after-commit'); };
    const outcome = await releaseMaintenance(input);
    assert.equal(outcome.state, 'released');
    assert.equal(state.releaseActivity.disposals, 1);
    assert.equal(await readFile(activePath, 'utf8'), activeBytes);
    assert.equal(await readMaintenanceQuarantine(state.state), undefined);
    await state.assertHistory();
  } finally { await admission.release(); }
});


for (const failure of ['lost-response', 'unconfirmed', 'post-disposal-health']) {
  test(`activation ${failure} stays quarantined and never repeats the uncertain disposal`, async context => {
    const state = await recovered(context);
    const { input } = await preparedRelease(state);
    const dispose = state.releaseInput.probeEffects.disposeObservation;
    state.releaseInput.probeEffects.disposeObservation = async endpoint => {
      await dispose(endpoint);
      if (failure === 'lost-response') throw new Error('fixture-disposal-reply-lost');
      return failure === 'unconfirmed' ? false : true;
    };
    const health = state.releaseInput.probeEffects.globalHealth;
    state.releaseInput.probeEffects.globalHealth = async endpoint => {
      if (failure === 'post-disposal-health' && state.releaseActivity.disposed) return { healthy: false };
      return health(endpoint);
    };
    await assert.rejects(releaseMaintenance(input));
    assert.equal(state.releaseActivity.disposals, 1);
    assert.equal(state.releaseActivity.disposed, true);
    state.releaseInput.probeEffects.globalHealth = health;
    state.releaseInput.probeEffects.disposeObservation = dispose;
    await assert.rejects(releaseMaintenance(input), /maintenance_release_activation_uncertain_gate_held/);
    assert.equal(state.releaseActivity.disposals, 1);
    await assert.rejects(readFile(maintenanceReleasePaths(state.state).receipt), { code: 'ENOENT' });
    await assertQuarantined(state);
  });
}

test('unhealthy activation preflight makes no disposal attempt and remains retryable', async context => {
  const state = await recovered(context);
  const { input } = await preparedRelease(state);
  const health = state.releaseInput.probeEffects.globalHealth;
  state.releaseInput.probeEffects.globalHealth = async () => ({ healthy: false });
  await assert.rejects(releaseMaintenance(input), /maintenance_release_activation_unhealthy/);
  assert.equal(state.releaseActivity.disposals, 0);
  await assertQuarantined(state);
  state.releaseInput.probeEffects.globalHealth = health;
  assert.equal((await releaseMaintenance(input)).state, 'released');
  assert.equal(state.releaseActivity.disposals, 1);
  await state.assertHistory();
});

test('post-disposal interrupted gate commit requires its original digest and performs only global health on retry', async context => {
  const state = await recovered(context);
  const { input } = await preparedRelease(state);
  state.releaseInput.probeEffects.beforeGateCommit = async () => { throw new Error('fixture-gate-interrupted'); };
  await assert.rejects(releaseMaintenance(input), /fixture-gate-interrupted/);
  assert.equal(state.releaseActivity.disposals, 1);
  await assert.rejects(releaseMaintenance({ ...input, releaseDigest: 'e'.repeat(64) }),
    /maintenance_release_activation_retry_requires_original_digest/);
  await assert.rejects(releaseMaintenance({ ...state.releaseInput, mode: 'release' }),
    /maintenance_release_activation_retry_requires_original_digest/);
  await assertQuarantined(state);
  delete state.releaseInput.probeEffects.beforeGateCommit;
  const healthReads = state.releaseActivity.globalHealthReads;
  const outcome = await releaseMaintenance(input);
  assert.equal(outcome.state, 'released');
  assert.equal(state.releaseActivity.disposals, 1);
  assert.ok(state.releaseActivity.globalHealthReads > healthReads);
  await state.assertHistory();
});

test('new work after disposal is preserved and blocks release without refreshing directory instances', async context => {
  const state = await recovered(context);
  const { input } = await preparedRelease(state);
  let reminder;
  state.releaseInput.probeEffects.beforeGateCommit = async () => { reminder = await addPendingReminder(state); };
  await assert.rejects(releaseMaintenance(input), /maintenance_release_inventory_changed/);
  assert.equal(state.releaseActivity.disposals, 1);
  delete state.releaseInput.probeEffects.beforeGateCommit;
  await assert.rejects(releaseMaintenance(input), /maintenance_release_inventory_changed/);
  assert.equal(await readFile(reminder.path, 'utf8'), reminder.bytes);
  assert.equal(state.releaseActivity.disposals, 1);
  await assertQuarantined(state);
});

for (const field of ['digest', 'endpointDigest']) {
  test(`self-consistent activation records with changed ${field} cannot authorize release`, async context => {
    const state = await recovered(context);
    const { input } = await preparedRelease(state);
    state.releaseInput.probeEffects.beforeGateCommit = async () => { throw new Error('fixture-gate-interrupted'); };
    await assert.rejects(releaseMaintenance(input), /fixture-gate-interrupted/);
    delete state.releaseInput.probeEffects.beforeGateCommit;
    const observation = JSON.parse(await readFile(maintenanceReleasePaths(state.state).observation));
    const directory = join(state.root, 'maintenance-releases', observation.approvalDigest, 'activation');
    for (const suffix of ['attempt', 'confirmed']) {
      const path = join(directory, `${input.releaseDigest}-${suffix}.json`);
      const record = JSON.parse(await readFile(path));
      await writeFile(path, JSON.stringify({ ...record, [field]: 'e'.repeat(64) }));
    }
    await assert.rejects(releaseMaintenance(input), /maintenance_release_activation_receipt_invalid/);
    assert.equal(state.releaseActivity.disposals, 1);
    await assert.rejects(readFile(maintenanceReleasePaths(state.state).receipt), { code: 'ENOENT' });
    await assertQuarantined(state);
  });
}

const daemonGenerationChanges = {
  invocation: unit => { unit.invocationID = randomUUID().replaceAll('-', ''); },
  pid: unit => {
    unit.mainPID += 100_000;
    unit.processes[0].pid = unit.mainPID;
  },
  startTime: unit => { unit.processes[0].startTime = String(BigInt(unit.processes[0].startTime) + 1n); },
};

for (const [field, change] of Object.entries(daemonGenerationChanges)) {
  test(`confirmed disposal retry rejects changed daemon ${field} without another disposal or scoped read`, async context => {
    const state = await recovered(context);
    const { input } = await preparedRelease(state);
    state.releaseInput.probeEffects.afterPendingCommit = async () => { throw new Error('fixture-receipt-write-interrupted'); };
    await assert.rejects(releaseMaintenance(input), /fixture-receipt-write-interrupted/);
    delete state.releaseInput.probeEffects.afterPendingCommit;
    assert.equal((await state.pending()).status, 'completed');
    assert.equal(state.releaseActivity.disposals, 1);
    change(state.runtimeIdentity.units.find(unit => unit.unit === OWNERS));
    await assert.rejects(releaseMaintenance(input), /maintenance_release_runtime_changed/);
    assert.equal(state.releaseActivity.disposals, 1);
    assert.equal((await state.pending()).status, 'draining');
    await assert.rejects(readFile(maintenanceReleasePaths(state.state).receipt), { code: 'ENOENT' });
    await assertQuarantined(state);
  });

  test(`initial release commit rejects daemon ${field} changing after confirmed disposal`, async context => {
    const state = await recovered(context);
    const { input } = await preparedRelease(state);
    state.releaseInput.probeEffects.beforeGateCommit = async () => {
      assert.equal(state.releaseActivity.disposals, 1);
      change(state.runtimeIdentity.units.find(unit => unit.unit === OWNERS));
    };
    await assert.rejects(releaseMaintenance(input), /maintenance_release_runtime_changed/);
    assert.equal(state.releaseActivity.disposals, 1);
    assert.equal((await state.pending()).status, 'draining');
    await assert.rejects(readFile(maintenanceReleasePaths(state.state).receipt), { code: 'ENOENT' });
    await assertQuarantined(state);
  });
}


test('original synthetic parent and child transcripts survive recovery, observation and release unchanged', async context => {
  const state = await recovered(context, { history: true });
  assert.equal(state.recoveredReceipt.proof.sessions.length, 2);
  const original = JSON.stringify({ sessions: state.releaseActivity.sessions, messages: state.releaseActivity.messages });
  const { preview, input } = await preparedRelease(state);
  assert.equal(preview.eligible, true);
  assert.deepEqual(preview.proof.sessions, state.recoveredReceipt.proof.sessions);
  assert.equal((await releaseMaintenance(input)).state, 'released');
  assert.equal(JSON.stringify({ sessions: state.releaseActivity.sessions, messages: state.releaseActivity.messages }), original);
  await state.assertHistory();
});

for (const change of ['missing', 'transcript', 'ancestry', 'directory', 'children']) {
  test(`original ${change} history change cannot become a new release baseline`, async context => {
    const state = await recovered(context, { history: true });
    await observe(state);
    const current = state.releaseActivity;
    const changes = {
      missing: () => { current.sessions = []; },
      transcript: () => { current.messages.ses_fixture_child[1].parts[0].text = 'Different synthetic result'; },
      ancestry: () => { delete current.sessions.find(session => session.id === 'ses_fixture_child').parentID; },
      directory: () => { for (const session of current.sessions) session.directory = state.config; },
      children: () => {
        current.sessions.push({ id: 'ses_extra_child', directory: state.workspace, parentID: 'ses_fixture_parent' });
        current.messages.ses_extra_child = syntheticMessages('ses_extra_child');
      },
    };
    changes[change]();
    await assert.rejects(releaseMaintenance({ ...state.releaseInput, mode: 'release' }),
      /maintenance_release_original_history_changed/);
    assert.equal(state.releaseActivity.disposals, 0);
    await assertQuarantined(state);
  });
}

test('an extra quiet independent session does not rewrite or invalidate preserved original history', async context => {
  const state = await recovered(context, { history: true });
  await observe(state);
  state.releaseActivity.sessions.push({ id: 'ses_extra_root', directory: state.workspace });
  state.releaseActivity.messages.ses_extra_root = syntheticMessages('ses_extra_root');
  const preview = await releaseMaintenance({ ...state.releaseInput, mode: 'release' });
  assert.equal(preview.eligible, true);
  assert.equal(preview.proof.sessions.length, 3);
  for (const original of state.recoveredReceipt.proof.sessions) {
    assert.deepEqual(preview.proof.sessions.find(session => session.id === original.id), original);
  }
  assert.equal((await releaseMaintenance({ ...state.releaseInput, mode: 'release', releaseDigest: preview.digest })).state, 'released');
  await state.assertHistory();
});

test('moving runtime storage within the selected evidence root cannot substitute for the recovered database', async context => {
  const state = await recovered(context, { storageSubdirectories: true });
  await observe(state);
  state.releaseInput.probeEffects.storageRoots = async () => [join(state.workspace, 'other-storage')];
  await assert.rejects(releaseMaintenance({ ...state.releaseInput, mode: 'release' }), /maintenance_release_storage_changed/);
  assert.equal(state.releaseActivity.disposals, 0);
  await assertQuarantined(state);
});
