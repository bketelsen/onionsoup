import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { OperatorJobs } from '../src/operator-jobs.ts';
import { OperatorSupervisor, OPERATOR_SUPERVISOR_LIMITS } from '../src/operator-supervisor.ts';
import { OperatorWrites } from '../src/operator-write-host.ts';
import { OperatorWritePermissions } from '../src/operator-write-permission.ts';
import { OPERATOR_WRITE_TOOL } from '../src/operator-write-call.ts';
import { OPERATOR_INVESTIGATOR, type OperatorJobInput, type OperatorSessionSnapshot, type OperatorSupervisorClient } from '../src/operator-jobs-types.ts';

export type Context = Parameters<OperatorWrites['create']>[3];
type Ask = Parameters<Context['ask']>[0];
const execute = promisify(execFile);
export class HostSessions implements OperatorSupervisorClient {
  sessions = new Map<string, { title: string; directory: string; snapshot: OperatorSessionSnapshot }>();
  prompts = 0;
  async listSessions(directory: string) {
    return [...this.sessions].filter(([, session]) => session.directory === directory).map(([id, session]) => ({ id, title: session.title }));
  }
  async createSession(directory: string, title: string) {
    const id = `ses_host_${this.sessions.size}`;
    this.sessions.set(id, { title, directory, snapshot: { status: 'idle', messages: [] } });
    return { id };
  }
  async readSession(_directory: string, id: string) { return structuredClone(this.sessions.get(id)!.snapshot); }
  async prompt(_directory: string, id: string, messageID: string, text: string) {
    this.prompts++;
    const snapshot = this.sessions.get(id)!.snapshot;
    snapshot.status = 'busy';
    snapshot.messages.push({ id: messageID, role: 'user', text, tools: [] });
  }
  async abort() { throw new Error('unexpected_abort'); }
  tool(id: string, messageID: string, callID: string, name: string = OPERATOR_WRITE_TOOL) {
    const snapshot = this.sessions.get(id)!.snapshot;
    snapshot.messages.push({ id: messageID, role: 'assistant', parentID: snapshot.messages.filter(message => message.role === 'user').at(-1)!.id,
      text: '', tools: [{ callID, tool: name, status: 'running' }] });
  }
  finish(id: string) {
    const snapshot = this.sessions.get(id)!.snapshot;
    for (const message of snapshot.messages) for (const tool of message.tools) {
      if (tool.status === 'running') tool.status = 'completed';
    }
    const prompt = snapshot.messages.filter(message => message.role === 'user').at(-1)!;
    snapshot.messages.push({ id: `msg_final_${id}`, role: 'assistant', parentID: prompt.id, completed: true,
      text: 'Updated the approved title. The host diff is ready for your review; no tests or commit were performed.', tools: [] });
    snapshot.status = 'idle';
  }
}

export async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'operator-write-host-'));
  const directory = join(workspace, 'repo');
  await mkdir(directory);
  const git = (args: string[]) => execute('/usr/bin/git', ['-C', directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args]);
  await git(['init', '-q']);
  await writeFile(join(directory, 'README.md'), '# Original\n');
  await git(['add', 'README.md']);
  await git(['commit', '-qm', 'initial fixture']);
  const jobs = new OperatorJobs(join(workspace, 'state'), workspace, 'operator');
  const client = new HostSessions();
  const permissions = new OperatorWritePermissions({ eventGraceMs: 20 });
  const writes = new OperatorWrites(jobs, client, permissions);
  const supervisor = new OperatorSupervisor(jobs, client, { ...OPERATOR_SUPERVISOR_LIMITS, receiptGraceMs: 0 }, writes);
  const origin = { operator: 'operator', sessionID: 'ses_parent', directory: workspace };
  const intake = { messageID: 'msg_human', text: '  Update only the README title.  \n' };
  const input: OperatorJobInput = { key: 'host-edit', goal: 'Update the title', constraints: ['No unrelated edits, commit or push'],
    tasks: [{ id: 'edit', goal: 'Update README title', directory, access: 'write', files: ['README.md'], dependsOn: [] }] };
  const asks: Ask[] = [];
  function parent(onAsk?: (input: Ask) => Promise<void>, reply = 'once'): Context {
    const context: Context = {
      sessionID: origin.sessionID, messageID: `msg_gate_${asks.length}`, agent: 'operator', directory: workspace,
      abort: new AbortController().signal, metadata: () => {},
      ask: async request => {
        asks.push(request);
        const id = `permission_host_${asks.length}`;
        permissions.event({ type: 'permission.asked', properties: { id, sessionID: context.sessionID, ...request,
          tool: { messageID: context.messageID, callID: `call_gate_${asks.length}` } } });
        if (onAsk) await onAsk(request);
        permissions.event({ type: 'permission.replied', properties: { sessionID: context.sessionID, requestID: id, reply } });
      },
    };
    return context;
  }
  function childContext(sessionID: string, messageID: string): Context {
    return { sessionID, messageID, agent: OPERATOR_INVESTIGATOR, directory, abort: new AbortController().signal,
      metadata: () => {}, ask: async () => { throw new Error('unexpected_child_permission'); } };
  }
  return { workspace, directory, git, jobs, client, permissions, writes, supervisor, origin, intake, input, asks, parent, childContext };
}

export async function start(f: Awaited<ReturnType<typeof fixture>>) {
  const job = await f.writes.create(f.origin, f.intake, f.input, f.parent());
  await f.supervisor.tick();
  return f.jobs.get(f.origin, job.id);
}

