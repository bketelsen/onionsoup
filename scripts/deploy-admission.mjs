import { isAbandonedChild, childRecoverySnapshot } from '../packages/owners/src/child-recovery.ts';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { readFile, lstat, stat, readdir } from 'node:fs/promises';
import { Runtime } from '../packages/owners/src/runtime.ts';
import { chatPath } from '../packages/owners/src/chats.ts';
import { beginDrain, listAdmissions, markDeploymentWaiting, releaseDrain } from '../packages/owners/src/deployment-admission.ts';
import { workSessionDirectories } from '../packages/owners/src/session-directories.ts';
import { rememberedSession } from '../packages/owners/src/session-history.ts';

const fail = code => Object.assign(new Error(code), { code });

const ENDPOINT = 'opencode-endpoint.json';
const SURFACE_UNIT = 'onionsoup-surface.service';
const QUIET_SAMPLES = 5;
const QUIET_SAMPLE_MS = 1_000;

function loopback(url) {
  try {
    const address = new URL(url);
    return address.protocol === 'http:' && address.hostname === '127.0.0.1' &&
      /^\d+$/.test(address.port) && !address.username && !address.password &&
      address.pathname === '/' && !address.search && !address.hash;
  } catch {
    return false;
  }
}

async function identity(pid) {
  const record = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = record.slice(record.lastIndexOf(') ') + 2).split(' ');
  if (fields[0] === 'Z' || !/^\d+$/.test(fields[19] ?? '')) throw fail('deployment_endpoint_invalid');
  return { startTime: fields[19], parentPid: Number(fields[1]) };
}

/** Resolve on each probe, including after a restart; never accept a caller-chosen localhost server. */
export async function readOpencodeEndpoint(state, unit = SURFACE_UNIT) {
  try {
    const directory = join(state, 'deploy');
    const parent = await lstat(directory);
    const path = join(directory, ENDPOINT);
    const metadata = await lstat(path);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() ||
      (parent.mode & 0o077) || !metadata.isFile() || metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid() || (metadata.mode & 0o077)) throw fail('deployment_endpoint_invalid');
    const record = JSON.parse(await readFile(path, 'utf8'));
    if (!loopback(record.url) || record.username !== 'opencode' ||
      typeof record.password !== 'string' || record.password.length < 24 ||
      !/^[0-9a-f-]{36}$/.test(record.instanceId) ||
      !Number.isSafeInteger(record.surfacePid) || !Number.isSafeInteger(record.opencodePid)) {
      throw fail('deployment_endpoint_invalid');
    }
    const [surfaceOwner, childOwner] = await Promise.all([stat(`/proc/${record.surfacePid}`), stat(`/proc/${record.opencodePid}`)]);
    if (surfaceOwner.uid !== process.getuid() || childOwner.uid !== process.getuid()) throw fail('deployment_endpoint_invalid');
    const [surface, child, surfaceCgroup, childCgroup, command] = await Promise.all([
      identity(record.surfacePid), identity(record.opencodePid),
      readFile(`/proc/${record.surfacePid}/cgroup`, 'utf8'),
      readFile(`/proc/${record.opencodePid}/cgroup`, 'utf8'),
      readFile(`/proc/${record.opencodePid}/cmdline`, 'utf8'),
    ]);
    if (surface.startTime !== record.surfaceStartTime || child.startTime !== record.opencodeStartTime ||
      child.parentPid !== record.surfacePid ||
      !surfaceCgroup.split('\n').some(line => line.endsWith(`/${unit}`)) ||
      surfaceCgroup !== childCgroup) throw fail('deployment_endpoint_invalid');
    const args = command.split('\0').filter(Boolean);
    if (basename(args[0] ?? '') !== 'opencode' || args[1] !== 'serve' ||
      args[args.indexOf('--hostname') + 1] !== '127.0.0.1' ||
      args[args.indexOf('--port') + 1] !== new URL(record.url).port) {
      throw fail('deployment_endpoint_invalid');
    }
    // Re-read the inode: replacement during validation is not a stable identity.
    if ((await stat(path)).ino !== metadata.ino) throw fail('deployment_endpoint_invalid');
    return record;
  } catch {
    throw fail('deployment_endpoint_invalid');
  }
}

async function directories(runtime) {
  const places = new Set();
  for (const owner of runtime.declarations.owners.values()) {
    places.add(chatPath(runtime, owner.id));
    for (const view of runtime.repositoryViews(owner.id)) places.add(view.desk ?? join(runtime.desksRoot, owner.id));
  }
  if (runtime.declarations.operator) places.add(runtime.declarations.operator.directory);
  const items = await runtime.ledger.list();
  const history = [];
  for (const item of items) {
    if (!item.session) continue;
    const session = await rememberedSession(runtime, item.session.sessionID);
    if (!session) continue;
    if (session.owner !== item.owner || session.directory !== item.session.directory) throw fail('deployment_session_identity_conflict');
    history.push(session);
  }
  let hasUnavailableWork = items.some(item => item.activeRunner !== undefined);
  for (const scope of workSessionDirectories(items, history)) {
    const exists = await stat(scope.directory).then(metadata => metadata.isDirectory(), error => {
      if (error.code === 'ENOENT') return false;
      throw fail('deployment_work_directory_unavailable');
    });
    if (!exists || scope.retired) {
      if (scope.required) hasUnavailableWork = true;
      continue;
    }
    places.add(scope.directory);
  }
  return { places: [...places], hasUnavailableWork };
}

async function independentOpencode(endpoint) {
  const names = await readdir('/proc');
  for (const name of names) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    let metadata;
    try {
      metadata = await stat(`/proc/${name}`);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw fail('deployment_process_scan_unavailable');
    }
    if (metadata.uid !== process.getuid()) continue;
    let command;
    try {
      command = await readFile(`/proc/${name}/cmdline`, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw fail('deployment_process_scan_unavailable');
    }
    const args = command.split('\0');
    const executable = basename(args[0] ?? '');
    if (executable !== 'opencode' && !args.some(arg => basename(arg) === 'opencode' ||
      basename(arg).startsWith('opencode-'))) continue;
    if (Number(name) !== endpoint.opencodePid) return true;
    if ((await identity(Number(name))).startTime !== endpoint.opencodeStartTime) return true;
  }
  return false;
}

async function opencodeRequest(url, path, directory, credentials) {
  const address = new URL(path, url);
  address.searchParams.set('directory', directory);
  const headers = credentials ? { authorization: `Basic ${Buffer.from(credentials).toString('base64')}` } : {};
  const response = await fetch(address, { headers, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw fail('deployment_opencode_unavailable');
  return response.json();
}

export async function createAdmission(input) {
  if (!isAbsolute(input.state ?? '') || !isAbsolute(input.config ?? '')) throw fail('deployment_paths_required');
  if (input.opencodeUrl || input.opencodeCredentials) throw fail('deployment_opencode_override_forbidden');
  const runtime = await Runtime.open({ state: input.state, declarations: input.config });
  if (resolve(runtime.stateDirectory) !== resolve(input.state)) throw fail('deployment_state_mismatch');
  let target;
  const checks = input.admissionEffects ?? {};
  const endpointProbe = checks.endpoint ?? readOpencodeEndpoint;
  const request = checks.request ?? ((endpoint, path, directory) =>
    opencodeRequest(endpoint.url, path, directory, `${endpoint.username}:${endpoint.password}`));
  const processes = checks.processes ?? independentOpencode;
  const sleep = checks.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  async function completedTree(endpoint, session, directory, status, visited, candidate) {
    if (!session || typeof session.id !== 'string' || visited.has(session.id)) return false;
    if (session.directory !== directory || status[session.id]) return false;
    visited.add(session.id);
    if (session.parentID) {
      const identity = { childID: session.id, parentID: session.parentID, directory };
      if (await isAbandonedChild(input.state, identity)) return true;
      if (candidate?.childID === session.id && candidate.parentID === session.parentID && candidate.directory === directory) {
        const snapshot = childRecoverySnapshot(identity);
        return !snapshot.completed && snapshot.digest === candidate.digest;
      }
    }
    const messages = await request(endpoint, `/session/${encodeURIComponent(session.id)}/message`, directory);
    if (!Array.isArray(messages) || !messages.length) return false;
    const latestUser = messages.findLastIndex(message => message?.info?.role === 'user');
    const userID = messages[latestUser]?.info?.id;
    const last = messages.at(-1)?.info;
    if (latestUser < 0 || typeof userID !== 'string' || latestUser === messages.length - 1 ||
      last?.role !== 'assistant' || last.parentID !== userID || last.finish !== 'stop' ||
      typeof last.time?.completed !== 'number' || !Number.isFinite(last.time.completed)) return false;
    const children = await request(endpoint, `/session/${encodeURIComponent(session.id)}/children`, directory);
    if (!Array.isArray(children)) return false;
    for (const child of children) {
      if (child?.parentID !== session.id || !await completedTree(endpoint, child, directory, status, visited, candidate)) return false;
    }
    return true;
  }
  async function probe({ ignoreLeases = false, chatSessions = [], expectedEndpoint, candidate } = {}) {
    if (!ignoreLeases && (await listAdmissions(input.state)).some(lease => lease.alive)) return false;
    await runtime.reloadDeclarations();
    const endpoint = await endpointProbe(input.state);
    if (expectedEndpoint && (endpoint.instanceId !== expectedEndpoint.instanceId ||
      endpoint.opencodePid !== expectedEndpoint.opencodePid ||
      endpoint.opencodeStartTime !== expectedEndpoint.opencodeStartTime ||
      endpoint.surfacePid !== expectedEndpoint.surfacePid || endpoint.url !== expectedEndpoint.url)) {
      throw fail('quiet_endpoint_changed');
    }
    if (await processes(endpoint)) return false;
    const scopes = await directories(runtime);
    if (scopes.hasUnavailableWork) return false;
    const found = new Set();
    for (const directory of scopes.places) {
      const status = await request(endpoint, '/session/status', directory);
      const permissions = await request(endpoint, '/permission', directory);
      const questions = await request(endpoint, '/question', directory);
      if (!status || typeof status !== 'object' || Array.isArray(status) ||
        !Array.isArray(permissions) || !Array.isArray(questions)) throw fail('deployment_opencode_invalid');
      if (Object.keys(status).length || permissions.length || questions.length) return false;
      if (!chatSessions.length) continue;
      const sessions = await request(endpoint, '/session', directory);
      if (!Array.isArray(sessions)) throw fail('deployment_opencode_invalid');
      for (const session of sessions) {
        if (!chatSessions.includes(session?.id)) continue;
        if (session.parentID || session.directory !== directory) throw fail('quiet_session_unverified');
        found.add(session.id);
        if (!await completedTree(endpoint, session, directory, status, new Set(), candidate)) return false;
      }
    }
    if (found.size !== chatSessions.length) throw fail('quiet_session_unverified');
    checks.onProbe?.();
    return true;
  }
  return {
    async markWaiting(buildId) {
      await markDeploymentWaiting(input.state, buildId);
    },
    async drain(buildId) {
      await beginDrain(input.state, buildId);
      target = buildId;
    },
    async quiescent() {
      if (!target) return false;
      const pending = JSON.parse(await readFile(join(input.state, 'deploy', 'pending.json'), 'utf8'));
      if (pending.status !== 'draining' || pending.targetBuildId !== target) return false;
      return probe();
    },
    async childRecoveryQuiet(candidate, expectedEndpoint) {
      const options = { ignoreLeases: true, chatSessions: [candidate.parentID], expectedEndpoint, candidate };
      if (!await probe(options)) return false;
      for (let sample = 0; sample < QUIET_SAMPLES; sample++) {
        await sleep(QUIET_SAMPLE_MS);
        if (!await probe(options)) return false;
      }
      return true;
    },
    async quiet() {
      if (!await this.quiescent()) return false;
      for (let sample = 0; sample < QUIET_SAMPLES; sample++) {
        await sleep(QUIET_SAMPLE_MS);
        if (!await this.quiescent()) return false;
      }
      return true;
    },
    async quiescentOrThrow() {
      if (!await this.quiescent()) throw fail('deployment_gate_not_quiescent');
    },
    async release(outcome) {
      await this.quiescentOrThrow();
      await releaseDrain(input.state, target, outcome);
    },
  };
}
