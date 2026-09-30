import { OPERATOR_ID } from './declarations.ts';
import type { OperatorJobs } from './operator-jobs.ts';
import { rememberSession } from './session-history.ts';
import type { Runtime } from './runtime.ts';
import type { Plugin } from '@opencode-ai/plugin';

/** Keep children reachable in the operator's existing history without inventing native parent relationships. */
export async function rememberOperatorChildren(runtime: Runtime, jobs: OperatorJobs, client: Parameters<Plugin>[0]['client']) {
  for (const job of await jobs.snapshot()) for (const child of job.children) {
    if (!child.sessionID) continue;
    const reply = await client.session.get({ path: { id: child.sessionID }, query: { directory: child.directory }, signal: AbortSignal.timeout(10_000) });
    const session = reply.data;
    if (reply.error || !session || session.id !== child.sessionID || session.directory !== child.directory || session.parentID) continue;
    await rememberSession(runtime, { id: session.id, owner: OPERATOR_ID, directory: child.directory,
      title: session.title, time: session.time });
  }
}
