import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { z } from 'zod';
import { Runtime } from '../packages/owners/src/runtime.ts';
import { chatPath } from '../packages/owners/src/chats.ts';
import { AdmissionRecord, listAdmissions } from '../packages/owners/src/deployment-admission.ts';
import { OperatorJobLedger } from '../packages/owners/src/operator-jobs-types.ts';
import { operatorCheckProcessIdentity } from '../packages/owners/src/operator-check-execution.ts';
import { createAdmission, readOpencodeEndpoint } from './deploy-admission.mjs';
import { EndpointIdentity, endpointIdentity, assertNoWork, readContext } from './notice-admission-probe.mjs';
import { fail, hash } from './admission-recovery-proof.mjs';

export { fail, hash } from './admission-recovery-proof.mjs';
export const MAINTENANCE_PROBE_LIMITS = { sessions: 10_000, entries: 500_000, bytes: 16 * 1024 ** 3,
  requestMs: 5_000, systemctlMs: 10_000 };
export const MAINTENANCE_UNITS = ['onionsoup-owners.service', 'onionsoup-surface.service'];
const execute = promisify(execFile);
const absolute = z.string().refine(value => isAbsolute(value) && resolve(value) === value);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const nonempty = z.string().min(1);
const unique = values => new Set(values).size === values.length;
export const Selection = z.object({ root: absolute, state: absolute, config: absolute,
  surfaceUrl: z.string().url(), expectedOld: commit, expectedTarget: commit,
  leases: z.array(z.uuid()).min(1).max(20), evidenceRoots: z.array(absolute).min(1).max(20),
}).strict().refine(value => unique(value.leases) && unique(value.evidenceRoots)
  && value.expectedOld !== value.expectedTarget, 'maintenance_recovery_selection_invalid');
const ProcessIdentity = z.object({ pid: z.number().int().positive(), startTime: z.string().regex(/^\d+$/) }).strict();
export const MaintenanceUnit = z.object({ unit: z.enum(MAINTENANCE_UNITS), invocationID: z.string().regex(/^[a-f0-9]{32}$/),
  mainPID: z.number().int().positive(), controlGroup: absolute, cgroupInode: z.string().regex(/^\d+$/),
  processes: z.array(ProcessIdentity).min(1), }).strict().refine(unit => basename(unit.controlGroup) === unit.unit
    && unique(unit.processes.map(process => process.pid)) && unit.processes.some(process => process.pid === unit.mainPID));
export const MaintenanceRuntimeIdentity = z.object({ bootID: z.uuid(), pidNamespace: z.string().regex(/^pid:\[\d+\]$/),
  units: z.array(MaintenanceUnit).length(2) }).strict().refine(value => unique(value.units.map(unit => unit.unit))
    && unique(value.units.flatMap(unit => unit.processes.map(process => process.pid))));
export const MaintenanceEvidence = z.object({ entries: z.array(z.object({ root: absolute, path: z.string(),
  type: z.enum(['file', 'directory', 'symlink', 'absent']), sha256: digest, mode: z.number().int().nonnegative().optional() }).strict()), digest }).strict();
export const MaintenanceLaunch = z.object({ units: z.array(z.object({ unit: z.enum(MAINTENANCE_UNITS),
  configurationDigest: digest, files: z.array(z.object({ path: absolute, digest }).strict()).min(1) }).strict()).length(2),
  digest }).strict().refine(value => unique(value.units.map(unit => unit.unit)));
const Session = z.object({ id: nonempty, directory: absolute, parentID: nonempty.optional() }).passthrough();
const SessionProof = z.object({ id: nonempty, directory: absolute, parentID: nonempty.optional(),
  sessionDigest: digest, transcriptDigest: digest, childrenDigest: digest }).strict();
export const MaintenanceProof = z.object({ selection: Selection,
  manifests: z.array(z.object({ build: commit, digest }).strict()).length(2), endpoint: EndpointIdentity,
  leases: z.array(AdmissionRecord.extend({ alive: z.literal(true) }).strict()),
  leaseFiles: z.array(z.object({ id: z.uuid(), digest }).strict()),
  runtime: MaintenanceRuntimeIdentity, launch: MaintenanceLaunch, capability: z.object({ version: z.literal(1), manifestDigest: digest }).strict(),
  runtimeStorage: z.object({ roots: z.array(absolute).min(1), digest }).strict(),
  evidence: MaintenanceEvidence, sessions: z.array(SessionProof), directories: z.array(absolute),
  registryDigest: digest }).strict();

function bytesDigest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function missing(error) { return ['ENOENT', 'ESRCH'].includes(error.code); }

/** Public probes contain fingerprints, never credentials or transcript/configuration contents. */
async function request(endpoint, path, directory) {
  const url = new URL(path, endpoint.url);
  if (directory !== undefined) url.searchParams.set('directory', directory);
  const authorization = `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString('base64')}`;
  const response = await fetch(url, { headers: { authorization }, redirect: 'error',
    signal: AbortSignal.timeout(MAINTENANCE_PROBE_LIMITS.requestMs) });
  if (!response.ok) throw fail('maintenance_recovery_runtime_unavailable');
  if (path.startsWith('/experimental/session') && (response.headers.has('x-next-cursor')
    || /rel=["']?next/.test(response.headers.get('link') ?? ''))) throw fail('maintenance_recovery_registry_incomplete');
  return response.json();
}

async function systemdUnit(unit) {
  const { stdout } = await execute('systemctl', ['--user', 'show', unit,
    '--property=MainPID,InvocationID,ControlGroup,ActiveState,SubState,KillMode'],
  { timeout: MAINTENANCE_PROBE_LIMITS.systemctlMs });
  return Object.fromEntries(stdout.trim().split('\n').map(line => {
    const boundary = line.indexOf('=');
    return [line.slice(0, boundary), line.slice(boundary + 1)];
  }));
}
const launchProperties = ['ExecStart', 'WorkingDirectory', 'Environment', 'EnvironmentFiles', 'FragmentPath',
  'DropInPaths', 'ExecStartPre', 'ExecStartPost', 'ExecCondition', 'PassEnvironment', 'UnsetEnvironment',
  'RootDirectory', 'RootImage', 'BindPaths', 'BindReadOnlyPaths', 'TemporaryFileSystem'];
const launchProfile = {
  'onionsoup-owners.service': { entry: 'packages/owners/src/cli.ts', suffix: ' daemon',
    environment: ['PATH', 'ONIONSOUP_HOME', 'ONIONSOUP_CONFIG'] },
  'onionsoup-surface.service': { entry: 'packages/surface/src/main.ts', suffix: '',
    environment: ['PATH', 'ONIONSOUP_HOME', 'ONIONSOUP_CONFIG', 'SURFACE_PORT', 'ONIONSOUP_RELEASE_MANIFEST'] },
};
const unitDirectives = {
  Unit: new Set(['Description', 'After']),
  Service: new Set(['Type', 'WorkingDirectory', 'Environment', 'ExecStart', 'Restart', 'RestartSec',
    'KillSignal', 'TimeoutStopSec', 'KillMode']),
  Install: new Set(['WantedBy']),
};
function properties(stdout) {
  return Object.fromEntries(stdout.trim().split('\n').map(line => {
    const boundary = line.indexOf('=');
    return [line.slice(0, boundary), line.slice(boundary + 1)];
  }));
}
function systemdWords(value) {
  if (/[\\\n\r]/.test(value)) throw fail('maintenance_recovery_launch_unsupported');
  const words = value.match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? [];
  if (words.join(' ') !== value.trim().replace(/ +/g, ' ')) throw fail('maintenance_recovery_launch_unsupported');
  return words.map(word => /^["']/.test(word) ? word.slice(1, -1) : word);
}
function validateUnitFile(contents) {
  let section;
  for (const line of contents.split('\n').map(value => value.trim()).filter(value => value && !/^[#;]/.test(value))) {
    if (/^\[[^\]]+\]$/.test(line)) {
      section = line.slice(1, -1);
      if (!unitDirectives[section]) throw fail('maintenance_recovery_launch_unsupported');
      continue;
    }
    const boundary = line.indexOf('=');
    if (boundary < 0 || !unitDirectives[section]?.has(line.slice(0, boundary).trim()) || line.endsWith('\\')) {
      throw fail('maintenance_recovery_launch_unsupported');
    }
  }
}
function validateLaunchEnvironment(selection, unit, current, manager) {
  const profile = launchProfile[unit];
  const environment = properties(systemdWords(current.Environment ?? '').join('\n'));
  if (Object.keys(environment).some(key => !profile.environment.includes(key))
    || profile.environment.some(key => !environment[key])) throw fail('maintenance_recovery_launch_unsupported');
  if (Object.keys(manager).some(key => /^(?:NODE_|OPENCODE_|ONIONSOUP_|LD_|BUN_|TSX_|MISE_|ASDF_)/.test(key)
    && !Object.hasOwn(environment, key))) throw fail('maintenance_recovery_launch_environment_unsupported');
  if (join(environment.ONIONSOUP_HOME, 'state') !== selection.state || environment.ONIONSOUP_CONFIG !== selection.config) {
    throw fail('maintenance_recovery_launch_state_mismatch');
  }
  if (unit === 'onionsoup-surface.service' && (environment.SURFACE_PORT !== new URL(selection.surfaceUrl).port
    || environment.ONIONSOUP_RELEASE_MANIFEST !== join(selection.root, 'current/packages/surface/release-manifest.json'))) {
    throw fail('maintenance_recovery_launch_surface_mismatch');
  }
}
/** Validate the narrow, directly launched source profile before any replacement can start. */
export function validateMaintenanceLaunchProfile(selection, unit, current, manager = {}) {
  const profile = launchProfile[unit];
  if (!profile) throw fail('maintenance_recovery_launch_unsupported');
  const executable = join(homedir(), '.local/share/mise/shims/node');
  const argv = `${executable} --conditions=onionsoup-source --import tsx ${join(selection.root, 'current', profile.entry)}${profile.suffix}`;
  const parsed = /^\{ path=([^;]+) ; argv\[\]=([^;]+) ; ignore_errors=no ;[^{}]*\}$/.exec(current.ExecStart ?? '');
  if (!parsed || parsed[1] !== executable || parsed[2] !== argv
    || current.WorkingDirectory !== join(selection.root, 'current')) throw fail('maintenance_recovery_launch_unsupported');
  for (const key of launchProperties.slice(4).filter(key => !['FragmentPath', 'DropInPaths'].includes(key))) {
    if (current[key]) throw fail('maintenance_recovery_launch_unsupported');
  }
  if (current.EnvironmentFiles) throw fail('maintenance_recovery_launch_unsupported');
  validateLaunchEnvironment(selection, unit, current, manager);
  return { executable, argv };
}
async function launchUnit(selection, unit, manager) {
  const { stdout } = await execute('systemctl', ['--user', 'show', unit, `--property=${launchProperties.join(',')}`],
    { timeout: MAINTENANCE_PROBE_LIMITS.systemctlMs });
  const current = properties(stdout);
  const { executable, argv } = validateMaintenanceLaunchProfile(selection, unit, current, manager);
  const paths = [absolute.parse(current.FragmentPath), ...systemdWords(current.DropInPaths ?? '').map(path => absolute.parse(path))];
  const files = [];
  for (const path of paths) {
    const contents = await readFile(path, 'utf8');
    validateUnitFile(contents);
    files.push({ path, digest: bytesDigest(contents) });
  }
  files.push({ path: executable, digest: bytesDigest(await readFile(executable)) });
  const stable = { ...current, ExecStart: { executable, argv }, managerDigest: hash(manager) };
  return { unit, configurationDigest: hash(stable), files };
}
async function readLaunchConfiguration(selection) {
  const { stdout } = await execute('systemctl', ['--user', 'show-environment'],
    { timeout: MAINTENANCE_PROBE_LIMITS.systemctlMs });
  const manager = properties(stdout);
  const units = await Promise.all(MAINTENANCE_UNITS.map(unit => launchUnit(selection, unit, manager)));
  return { units, digest: hash(units) };
}
async function launchConfiguration(selection, effects) {
  const launch = MaintenanceLaunch.parse(await (effects.launchConfiguration ?? readLaunchConfiguration)(selection));
  if (launch.digest !== hash(launch.units)) throw fail('maintenance_recovery_launch_invalid');
  return launch;
}
export async function verifyMaintenanceTargetLaunch(proof, effects = {}) {
  if (hash(await launchConfiguration(proof.selection, effects)) !== hash(proof.launch)) {
    throw fail('maintenance_recovery_launch_changed');
  }
  return true;
}

async function domain() {
  return { bootID: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    pidNamespace: await readlink('/proc/self/ns/pid') };
}
async function processIdentity(pid) {
  const metadata = await stat(`/proc/${pid}`);
  if (metadata.uid !== process.getuid()) throw fail('maintenance_recovery_process_foreign');
  const observed = operatorCheckProcessIdentity(await readFile(`/proc/${pid}/stat`, 'utf8'));
  if (observed.pid !== pid) throw fail('maintenance_recovery_process_foreign');
  return { pid, startTime: observed.started };
}
function cgroupPath(controlGroup) {
  if (!absolute.safeParse(controlGroup).success || controlGroup === '/') throw fail('maintenance_recovery_cgroup_invalid');
  return join('/sys/fs/cgroup', controlGroup);
}
async function cgroupProcesses(path) {
  const processes = new Set((await readFile(join(path, 'cgroup.procs'), 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number));
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) for (const pid of await cgroupProcesses(join(path, entry.name))) processes.add(pid);
  }
  if ([...processes].some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw fail('maintenance_recovery_cgroup_invalid');
  return processes;
}
async function unitIdentity(unit) {
  const current = await systemdUnit(unit);
  if (current.ActiveState !== 'active' || !['control-group', 'mixed'].includes(current.KillMode)
    || !/^[a-f0-9]{32}$/.test(current.InvocationID ?? '')) throw fail('maintenance_recovery_unit_unverified');
  const path = cgroupPath(current.ControlGroup);
  if (await realpath(path) !== path) throw fail('maintenance_recovery_cgroup_invalid');
  const metadata = await stat(path);
  const pids = await cgroupProcesses(path);
  if (!pids.has(Number(current.MainPID))) throw fail('maintenance_recovery_unit_unverified');
  const processes = await Promise.all([...pids].sort((left, right) => left - right).map(processIdentity));
  return MaintenanceUnit.parse({ unit, invocationID: current.InvocationID, mainPID: Number(current.MainPID),
    controlGroup: current.ControlGroup, cgroupInode: String(metadata.ino), processes });
}
async function assertContainedDescendants(identity) {
  const captured = new Map(identity.units.flatMap(unit => unit.processes.map(process => [process.pid, process.startTime])));
  const observed = [];
  for (const name of await readdir('/proc')) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    try {
      if ((await stat(`/proc/${name}`)).uid !== process.getuid()) continue;
      observed.push(operatorCheckProcessIdentity(await readFile(`/proc/${name}/stat`, 'utf8')));
    } catch (error) { if (!missing(error)) throw error; }
  }
  for (const process of observed) {
    if (captured.has(process.pid) && captured.get(process.pid) !== process.started) {
      throw fail('maintenance_recovery_process_foreign');
    }
    if (captured.has(process.parent) && !captured.has(process.pid)) {
      throw fail('maintenance_recovery_uncontained_descendant');
    }
  }
  for (const unit of identity.units) {
    if (await readlink(`/proc/${unit.mainPID}/ns/pid`) !== identity.pidNamespace) {
      throw fail('maintenance_recovery_process_foreign');
    }
  }
}

export async function readMaintenanceRuntimeIdentity(endpoint) {
  const identity = MaintenanceRuntimeIdentity.parse({ ...await domain(), units: await Promise.all(MAINTENANCE_UNITS.map(unitIdentity)) });
  await assertContainedDescendants(identity);
  const surface = identity.units.find(unit => unit.unit === 'onionsoup-surface.service');
  if (surface.mainPID !== endpoint.surfacePid || !surface.processes.some(process => process.pid === endpoint.surfacePid
    && process.startTime === endpoint.surfaceStartTime) || !surface.processes.some(process => process.pid === endpoint.opencodePid
    && process.startTime === endpoint.opencodeStartTime)) throw fail('maintenance_recovery_endpoint_changed');
  return identity;
}

async function defaultInspectUnit(identity, name) {
  if (hash(await domain()) !== hash({ bootID: identity.bootID, pidNamespace: identity.pidNamespace })) return 'foreign';
  const expected = identity.units.find(unit => unit.unit === name);
  if (!expected) return 'foreign';
  const current = await systemdUnit(name);
  const remaining = [];
  for (const process of expected.processes) {
    try {
      const observed = await processIdentity(process.pid);
      if (hash(observed) !== hash(process)) return 'foreign';
      remaining.push(observed);
    } catch (error) { if (!missing(error)) throw error; }
  }
  let group;
  try { group = await stat(cgroupPath(expected.controlGroup)); }
  catch (error) { if (!missing(error)) throw error; }
  if (group && String(group.ino) !== expected.cgroupInode) return 'foreign';
  if (Number(current.MainPID) > 0 || ['active', 'activating', 'reloading'].includes(current.ActiveState)) {
    if (current.InvocationID !== expected.invocationID || Number(current.MainPID) !== expected.mainPID
      || current.ControlGroup !== expected.controlGroup) return 'foreign';
    return hash(await unitIdentity(name)) === hash(expected) ? 'original' : 'foreign';
  }
  if (!['inactive', 'failed'].includes(current.ActiveState) || remaining.length) return 'unavailable';
  if (group) {
    const populated = (await readFile(join(cgroupPath(expected.controlGroup), 'cgroup.events'), 'utf8'))
      .split('\n').find(line => line.startsWith('populated '));
    if (populated !== 'populated 0' || (await cgroupProcesses(cgroupPath(expected.controlGroup))).size) return 'unavailable';
  }
  return 'stopped';
}
export async function inspectMaintenanceUnit(proof, unit, effects = {}) {
  try { return z.enum(['original', 'stopped', 'foreign', 'unavailable']).parse(
    await (effects.inspectUnit ?? defaultInspectUnit)(proof.runtime, unit)); }
  catch { return 'unavailable'; }
}
export async function inspectStoppedMaintenance(proof, effects = {}) {
  const states = await Promise.all(MAINTENANCE_UNITS.map(unit => inspectMaintenanceUnit(proof, unit, effects)));
  if (states.every(state => state === 'stopped')) return { state: 'stopped', reason: 'maintenance_recovery_runtime_stopped',
    proof: { runtime: proof.runtime, observedAt: new Date().toISOString() } };
  const state = states.includes('foreign') ? 'foreign' : states.includes('original') ? 'running' : 'unavailable';
  return { state, reason: `maintenance_recovery_runtime_${state}` };
}

function excludedStatePath(path) {
  const names = path.split('/');
  return ['deploy', 'logs'].includes(names[0]) || names.some(name => name.endsWith('.lock') || name.endsWith('.tmp'));
}
/** Exclusions are limited to state coordination/log files; evidence roots never exclude SQLite WAL/SHM. */
export async function fingerprintEvidence(selection, workspaceRoots = []) {
  const entries = [];
  let bytes = 0;
  const roots = [...new Set([selection.state, selection.config, ...selection.evidenceRoots, ...workspaceRoots])].sort();
  async function walk(root, relativePath) {
    if (root === selection.state && relativePath && excludedStatePath(relativePath)) return;
    const path = join(root, relativePath);
    let metadata;
    try { metadata = await lstat(path); }
    catch (error) {
      if (!relativePath && missing(error) && workspaceRoots.includes(root)) {
        entries.push({ root, path: '', type: 'absent', sha256: bytesDigest('absent') });
        return;
      }
      throw error;
    }
    if (entries.length >= MAINTENANCE_PROBE_LIMITS.entries) throw fail('maintenance_recovery_fingerprint_limit');
    const entry = { root, path: relativePath, type: 'directory', sha256: bytesDigest('directory'), mode: metadata.mode & 0o7777 };
    if (metadata.isSymbolicLink()) {
      if (!relativePath) throw fail('maintenance_recovery_root_symlink');
      entry.type = 'symlink';
      entry.sha256 = bytesDigest(await readlink(path));
    } else if (metadata.isFile()) {
      bytes += metadata.size;
      if (bytes > MAINTENANCE_PROBE_LIMITS.bytes) throw fail('maintenance_recovery_fingerprint_limit');
      entry.type = 'file';
      entry.sha256 = bytesDigest(await readFile(path));
      const after = await lstat(path);
      if (after.ino !== metadata.ino || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || after.mode !== metadata.mode) {
        throw fail('maintenance_recovery_evidence_changed');
      }
    } else if (!metadata.isDirectory()) throw fail('maintenance_recovery_special_evidence');
    entries.push(entry);
    if (metadata.isDirectory()) for (const name of (await readdir(path)).sort()) await walk(root, relativePath ? `${relativePath}/${name}` : name);
  }
  for (const root of roots) {
    try {
      if (await realpath(root) !== root) throw fail('maintenance_recovery_root_symlink');
    } catch (error) { if (!missing(error) || !workspaceRoots.includes(root)) throw error; }
    await walk(root, '');
  }
  return MaintenanceEvidence.parse({ entries, digest: hash(entries) });
}

async function defaultStorageRoots(endpoint) {
  const before = await processIdentity(endpoint.opencodePid);
  if (before.startTime !== endpoint.opencodeStartTime) throw fail('maintenance_recovery_endpoint_changed');
  const environment = new Map();
  const wanted = new Set(['HOME', 'XDG_DATA_HOME', 'OPENCODE_TEST_HOME']);
  for (const entry of (await readFile(`/proc/${endpoint.opencodePid}/environ`, 'utf8')).split('\0')) {
    const boundary = entry.indexOf('=');
    if (wanted.has(entry.slice(0, boundary))) environment.set(entry.slice(0, boundary), entry.slice(boundary + 1));
  }
  const home = absolute.parse(environment.get('OPENCODE_TEST_HOME') || environment.get('HOME'));
  const data = environment.get('XDG_DATA_HOME') || join(home, '.local/share');
  const expected = await realpath(join(absolute.parse(data), 'opencode'));
  const roots = new Set();
  for (const descriptor of await readdir(`/proc/${endpoint.opencodePid}/fd`)) {
    let target;
    try { target = await readlink(`/proc/${endpoint.opencodePid}/fd/${descriptor}`); }
    catch (error) { if (missing(error)) continue; throw error; }
    if (basename(target) !== 'opencode.db') continue;
    const database = await realpath(target);
    if (dirname(database) !== expected) throw fail('maintenance_recovery_storage_unverified');
    const file = await open(database, 'r');
    try {
      const header = Buffer.alloc(16);
      await file.read(header, 0, header.length, 0);
      if (!header.equals(Buffer.from('SQLite format 3\0'))) throw fail('maintenance_recovery_storage_unverified');
    } finally { await file.close(); }
    roots.add(expected);
  }
  if (!roots.size || hash(await processIdentity(endpoint.opencodePid)) !== hash(before)) {
    throw fail('maintenance_recovery_storage_unverified');
  }
  return [...roots];
}
async function storageEvidence(selection, endpoint, effects) {
  const roots = [...new Set(z.array(absolute).min(1).parse(await (effects.storageRoots ?? defaultStorageRoots)(endpoint)))].sort();
  const declared = await Promise.all(selection.evidenceRoots.map(root => realpath(root)));
  for (const root of roots) {
    if (await realpath(root) !== root || !declared.some(parent => {
      const suffix = relative(parent, root);
      return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../'));
    })) throw fail('maintenance_recovery_storage_not_selected');
  }
  return { roots, digest: hash(roots) };
}

async function targetCapability(selection) {
  const bytes = await readFile(join(selection.root, 'releases', selection.expectedTarget, 'packages/surface/release-manifest.json'), 'utf8');
  const manifest = JSON.parse(bytes);
  if (manifest.buildId !== selection.expectedTarget || manifest.capabilities?.legacyMaintenanceQuarantine !== 1) {
    throw fail('maintenance_recovery_target_quarantine_missing');
  }
  return { version: 1, manifestDigest: hash(bytes) };
}
async function selectedLeases(selection, endpoint) {
  const live = (await listAdmissions(selection.state)).filter(lease => lease.alive);
  if (hash(live.map(lease => lease.id).sort()) !== hash([...selection.leases].sort())) throw fail('maintenance_recovery_unexpected_lease');
  const selected = [];
  const leaseFiles = [];
  for (const lease of live.sort((left, right) => left.id.localeCompare(right.id))) {
    const bytes = await readFile(join(selection.state, 'deploy/leases', `${lease.id}.json`), 'utf8');
    const legacy = z.object({ id: z.uuid(), kind: z.enum(['plugin:notices', 'plugin:operator-jobs']),
      pid: z.number().int().positive(), startTime: z.string().regex(/^\d+$/) }).strict().parse(JSON.parse(bytes));
    if (hash(legacy) !== hash({ id: lease.id, kind: lease.kind, pid: lease.pid, startTime: lease.startTime })
      || legacy.pid !== endpoint.opencodePid || legacy.startTime !== endpoint.opencodeStartTime) {
      throw fail('maintenance_recovery_lease_identity_mismatch');
    }
    selected.push({ ...legacy, alive: true });
    leaseFiles.push({ id: legacy.id, digest: hash(bytes) });
  }
  return { leases: selected, leaseFiles };
}

async function knownDirectories(runtime) {
  const places = new Set();
  for (const owner of runtime.declarations.owners.values()) {
    places.add(chatPath(runtime, owner.id));
    for (const view of runtime.repositoryViews(owner.id)) {
      places.add(view.workspace);
      places.add(view.desk ?? join(runtime.desksRoot, owner.id));
    }
  }
  if (runtime.declarations.operator) places.add(runtime.declarations.operator.directory);
  for (const item of await runtime.ledger.list()) {
    for (const path of [item.planWorktree, item.session?.directory, item.origin?.directory]) if (path) places.add(path);
  }
  try {
    const ledger = OperatorJobLedger.parse(JSON.parse(await readFile(join(runtime.stateDirectory, 'operator-jobs/jobs.json'), 'utf8')));
    for (const job of ledger.jobs) {
      places.add(job.origin.directory);
      for (const child of job.children) places.add(child.directory);
      for (const claim of job.applicationClaims ?? []) places.add(claim.target.directory);
    }
  } catch (error) { if (!missing(error)) throw error; }
  return [...places].map(path => absolute.parse(path)).sort();
}

async function registrySnapshot(endpoint, read) {
  const path = `/experimental/session?archived=true&roots=false&limit=${MAINTENANCE_PROBE_LIMITS.sessions + 1}`;
  const sessions = z.array(Session).parse(await read(endpoint, path));
  if (sessions.length > MAINTENANCE_PROBE_LIMITS.sessions || !unique(sessions.map(session => session.id))) {
    throw fail('maintenance_recovery_registry_incomplete');
  }
  return sessions.sort((left, right) => left.id.localeCompare(right.id));
}
async function sessionEvidence(endpoint, registry, read) {
  const indexed = new Map(registry.map(session => [session.id, session]));
  for (const session of registry) {
    const seen = new Set();
    let current = session;
    while (current) {
      if (seen.has(current.id)) throw fail('maintenance_recovery_session_ancestry_unavailable');
      seen.add(current.id);
      current = current.parentID ? indexed.get(current.parentID) : undefined;
    }
  }
  const evidence = [];
  for (const session of registry) {
    if (session.parentID && (!indexed.has(session.parentID)
      || indexed.get(session.parentID).directory !== session.directory)) throw fail('maintenance_recovery_session_ancestry_unavailable');
    const current = Session.parse(await read(endpoint, `/session/${encodeURIComponent(session.id)}`, session.directory));
    if (current.id !== session.id || current.directory !== session.directory || current.parentID !== session.parentID) {
      throw fail('maintenance_recovery_session_changed');
    }
    const messages = z.array(z.unknown()).parse(await read(endpoint, `/session/${encodeURIComponent(session.id)}/message`, session.directory));
    for (const message of messages) {
      if (!message || typeof message !== 'object' || message.info?.sessionID !== session.id || !Array.isArray(message.parts)) {
        throw fail('maintenance_recovery_transcript_unavailable');
      }
      if (message.parts.some(part => part?.type === 'tool' && !['completed', 'error'].includes(part.state?.status))) {
        throw fail('maintenance_recovery_active_tool');
      }
    }
    const children = z.array(Session).parse(await read(endpoint, `/session/${encodeURIComponent(session.id)}/children`, session.directory));
    const expected = registry.filter(child => child.parentID === session.id).map(child => child.id).sort();
    if (hash(children.map(child => child.id).sort()) !== hash(expected)
      || children.some(child => child.parentID !== session.id || child.directory !== session.directory)) {
      throw fail('maintenance_recovery_session_tree_changed');
    }
    evidence.push({ id: session.id, directory: session.directory, parentID: session.parentID,
      sessionDigest: hash(current), transcriptDigest: hash(messages), childrenDigest: hash(children.sort((left, right) => left.id.localeCompare(right.id))) });
  }
  return evidence;
}
async function quietDirectories(endpoint, directories, read) {
  for (const directory of directories) {
    const status = z.record(z.string(), z.unknown()).parse(await read(endpoint, '/session/status', directory));
    const permissions = z.array(z.unknown()).parse(await read(endpoint, '/permission', directory));
    const questions = z.array(z.unknown()).parse(await read(endpoint, '/question', directory));
    if (Object.keys(status).length || permissions.length || questions.length) throw fail('maintenance_recovery_active_runtime');
  }
}

/** Quietness excludes competing visible activity; selected legacy operations remain explicitly unknown. */
export async function probeMaintenanceAdmissions(input, effects = {}, statuses = ['armed', 'waiting']) {
  const selection = Selection.parse(input);
  selection.leases.sort();
  selection.evidenceRoots.sort();
  const context = await readContext(selection, statuses);
  const endpoint = await (effects.endpoint ?? readOpencodeEndpoint)(selection.state);
  const read = effects.request ?? request;
  const identity = endpointIdentity(endpoint);
  const runtime = await Runtime.open({ state: selection.state, declarations: selection.config });
  try {
    await assertNoWork(runtime);
    const processIdentity = MaintenanceRuntimeIdentity.parse(await (effects.runtimeIdentity ?? readMaintenanceRuntimeIdentity)(endpoint));
    const selected = await selectedLeases(selection, endpoint);
    const surface = processIdentity.units.find(unit => unit.unit === 'onionsoup-surface.service');
    if (surface.mainPID !== endpoint.surfacePid || !surface.processes.some(process => process.pid === endpoint.surfacePid
      && process.startTime === endpoint.surfaceStartTime) || !surface.processes.some(process => process.pid === endpoint.opencodePid
      && process.startTime === endpoint.opencodeStartTime)) throw fail('maintenance_recovery_endpoint_changed');
    const capability = await (effects.targetCapability ?? targetCapability)(selection);
    const launch = await launchConfiguration(selection, effects);
    const runtimeStorage = await storageEvidence(selection, endpoint, effects);
    const registry = await registrySnapshot(endpoint, read);
    const directories = [...new Set([...await knownDirectories(runtime), ...registry.map(session => session.directory)])].sort();
    const evidence = MaintenanceEvidence.parse(await (effects.fingerprint ?? fingerprintEvidence)(selection, directories));
    const sessions = await sessionEvidence(endpoint, registry, read);
    await quietDirectories(endpoint, directories, read);
    const admission = await createAdmission({ ...selection, admissionEffects: { ...effects, request: read } });
    if (!await admission.bootstrapQuiet([], endpoint)) throw fail('maintenance_recovery_not_quiet');
    await assertNoWork(runtime);
    const afterRegistry = await registrySnapshot(endpoint, read);
    if (hash(afterRegistry) !== hash(registry) || hash(await sessionEvidence(endpoint, afterRegistry, read)) !== hash(sessions)
      || hash(await (effects.fingerprint ?? fingerprintEvidence)(selection, directories)) !== hash(evidence)
      || hash(await (effects.runtimeIdentity ?? readMaintenanceRuntimeIdentity)(endpoint)) !== hash(processIdentity)
      || hash(await selectedLeases(selection, endpoint)) !== hash(selected)
      || hash(await storageEvidence(selection, endpoint, effects)) !== hash(runtimeStorage)
      || hash(await launchConfiguration(selection, effects)) !== hash(launch)
      || hash(await readContext(selection, statuses)) !== hash(context)
      || hash(endpointIdentity(await (effects.endpoint ?? readOpencodeEndpoint)(selection.state))) !== hash(identity)) {
      throw fail('maintenance_recovery_evidence_changed');
    }
    await quietDirectories(endpoint, directories, read);
    const proof = MaintenanceProof.parse({ ...context, endpoint: identity, ...selected, runtime: processIdentity,
      capability, launch, runtimeStorage, evidence, sessions, directories, registryDigest: hash(registry) });
    return { state: 'preview', digest: hash(proof), proof };
  } finally { runtime.close(); }
}

async function originalMaintenanceSurface(proof, effects) {
  const states = await Promise.all(MAINTENANCE_UNITS.map(unit => inspectMaintenanceUnit(proof, unit, effects)));
  if (states.some(state => !['original', 'stopped'].includes(state))) {
    throw fail('maintenance_recovery_original_process_unverified');
  }
  if (states.every(state => state === 'stopped')) {
    const stopped = await inspectStoppedMaintenance(proof, effects);
    if (stopped.state !== 'stopped') throw fail('maintenance_recovery_stop_unverified_gate_held');
    return stopped;
  }
  if (states[MAINTENANCE_UNITS.indexOf('onionsoup-surface.service')] !== 'original') {
    throw fail('maintenance_recovery_activity_unavailable');
  }
  return { state: 'original' };
}

async function verifyBeforeStopEvidence(proof, runtime, endpoint, effects) {
  const selection = proof.selection;
  const read = effects.request ?? request;
  const registry = await registrySnapshot(endpoint, read);
  const directories = [...new Set([...await knownDirectories(runtime), ...registry.map(session => session.directory)])].sort();
  const selected = await selectedLeases(selection, endpoint);
  const context = await readContext(selection, ['draining']);
  if (hash(registry) !== proof.registryDigest || hash(directories) !== hash(proof.directories)
    || hash(await sessionEvidence(endpoint, registry, read)) !== hash(proof.sessions)
    || hash(selected) !== hash({ leases: proof.leases, leaseFiles: proof.leaseFiles })
    || hash(context) !== hash({ selection, manifests: proof.manifests })
    || hash(await (effects.fingerprint ?? fingerprintEvidence)(selection, directories)) !== hash(proof.evidence)
    || hash(await storageEvidence(selection, endpoint, effects)) !== hash(proof.runtimeStorage)) {
    throw fail('maintenance_recovery_evidence_changed');
  }
  await verifyMaintenanceTargetLaunch(proof, effects);
  await quietDirectories(endpoint, directories, read);
  await assertNoWork(runtime);
}

/** A saved checkpoint never substitutes for fresh evidence before another original process is stopped. */
export async function revalidateMaintenanceBeforeStop(proof, effects = {}) {
  const current = await originalMaintenanceSurface(proof, effects);
  if (current.state === 'stopped') return current;
  const selection = proof.selection;
  const endpoint = await (effects.endpoint ?? readOpencodeEndpoint)(selection.state);
  if (hash(endpointIdentity(endpoint)) !== hash(proof.endpoint)) throw fail('maintenance_recovery_endpoint_changed');
  const runtime = await Runtime.open({ state: selection.state, declarations: selection.config });
  try {
    await verifyBeforeStopEvidence(proof, runtime, endpoint, effects);
    const admission = await createAdmission({ ...selection, admissionEffects: { ...effects, request: effects.request ?? request } });
    if (!await admission.bootstrapQuiet([], endpoint)) throw fail('maintenance_recovery_not_quiet');
    await verifyBeforeStopEvidence(proof, runtime, endpoint, effects);
    if (hash(endpointIdentity(await (effects.endpoint ?? readOpencodeEndpoint)(selection.state))) !== hash(proof.endpoint)) {
      throw fail('maintenance_recovery_endpoint_changed');
    }
    const after = await originalMaintenanceSurface(proof, effects);
    if (after.state !== 'original') throw fail('maintenance_recovery_original_process_unverified');
    return { state: 'original', registryDigest: proof.registryDigest, evidenceDigest: proof.evidence.digest };
  } finally { runtime.close(); }
}
