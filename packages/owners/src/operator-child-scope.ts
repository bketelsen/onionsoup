import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { OPERATOR_INVESTIGATOR } from './operator-jobs-types.ts';
import type { OperatorJobs } from './operator-jobs.ts';

export async function operatorChild(jobs: OperatorJobs, sessionID: string) {
  for (const job of await jobs.snapshot()) {
    const child = job.children.find(candidate => candidate.sessionID === sessionID);
    if (child) return { job, child };
  }
}

/** Only the scheduler's durable exact attempt can start a managed child turn. */
export async function checkOperatorChildMessage(jobs: OperatorJobs, agent: string | undefined, sessionID: string, messageID?: string) {
  const bound = await operatorChild(jobs, sessionID);
  if (!bound && agent !== OPERATOR_INVESTIGATOR) return;
  const child = bound?.child;
  if (!child || agent !== OPERATOR_INVESTIGATOR || child.attempts.at(-1)?.messageID !== messageID
    || child.attempts.at(-1)?.endedAt) throw new Error('operator_child_message_unbound');
}

/** Native permissions deny effects; canonical paths also reject symlink escapes for file-reading tools. */
export async function checkOperatorChildTool(jobs: OperatorJobs, sessionID: string, tool: string, args: Record<string, unknown>) {
  const bound = await operatorChild(jobs, sessionID);
  if (!bound) return;
  const child = bound.child;
  if (!child.attempts.length || child.attempts.at(-1)?.endedAt) throw new Error('operator_child_not_running');
  if (!['read', 'glob', 'grep', 'list'].includes(tool)) throw new Error('operator_child_read_only');
  const path = tool === 'read' ? args.filePath : args.path ?? child.directory;
  if (typeof path !== 'string') throw new Error('operator_child_path_required');
  const target = await realpath(resolve(child.directory, path));
  const scope = await realpath(child.directory);
  if (scope !== child.directory) throw new Error('operator_child_workspace_changed');
  const inside = relative(scope, target);
  if (inside === '..' || inside.startsWith('../') || isAbsolute(inside)) throw new Error('operator_child_path_outside_scope');
  if (tool === 'glob' && (typeof args.pattern !== 'string' || isAbsolute(args.pattern)
    || args.pattern.split(/[\\/]/).includes('..'))) throw new Error('operator_child_pattern_outside_scope');
}
