import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { fail, hash } from './admission-recovery-proof.mjs';

export const FAILED_TOOL_BUILD = 'b2db85b5fa46b1d8f6608ab6e1c3e29a75da0f95';
export const FAILED_TOOL_OPENCODE = '1.18.33';
export const FAILED_TREE_LIMITS = { sessions: 20, depth: 8 };
const sessionID = z.string().regex(/^ses_[a-zA-Z0-9]+$/);
const messageID = z.string().regex(/^msg_[a-zA-Z0-9]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const directory = z.string().refine(value => isAbsolute(value) && resolve(value) === value);
export const FailedToolSelection = z.object({ sessionID, directory, toolSessionID: sessionID,
  messageID, callID: z.string().min(1), treeDigest: digest }).strict();
const Session = z.object({ id: sessionID, directory, parentID: sessionID.optional() }).passthrough();
const Message = z.object({ info: z.object({ id: messageID, role: z.string(), parentID: messageID.optional(),
  finish: z.string().optional(), time: z.object({ completed: z.number().finite().optional() }).passthrough().optional(),
}).passthrough(), parts: z.array(z.unknown()) }).passthrough();
const ToolPart = z.object({ id: z.string().min(1), type: z.literal('tool'), sessionID, messageID,
  callID: z.string().min(1), tool: z.string(), state: z.object({ status: z.enum(['completed', 'error']),
    error: z.string().optional(), time: z.object({ start: z.number().finite(), end: z.number().finite() }).passthrough(),
  }).passthrough() }).passthrough();
const CompletedSession = z.object({ sessionID, parentID: sessionID.optional(), directory,
  userID: messageID, finalID: messageID, transcriptDigest: digest, children: z.array(sessionID) }).strict();
export const FailedToolProof = z.object({ selection: FailedToolSelection, sessions: z.array(CompletedSession).min(2),
  partID: z.string(), userID: messageID, failedAt: z.number().finite(), errorDigest: digest }).strict();

function completed(messages) {
  const user = messages.findLast(message => message.info.role === 'user')?.info;
  const tail = messages.at(-1)?.info;
  if (!user || tail?.role !== 'assistant' || tail.parentID !== user.id || tail.finish !== 'stop'
    || !Number.isFinite(tail.time?.completed)) throw fail('notice_recovery_failed_tree_incomplete');
  return { userID: user.id, finalID: tail.id };
}

/** Read-only fingerprint, not permission to recover a completed tree. */
export async function readFailedToolTree(selection, endpoint, request) {
  const nodes = [];
  const seen = new Set();
  async function visit(id, parentID, depth) {
    if (seen.has(id) || seen.size >= FAILED_TREE_LIMITS.sessions || depth > FAILED_TREE_LIMITS.depth) {
      throw fail('notice_recovery_failed_tree_invalid');
    }
    seen.add(id);
    const path = `/session/${encodeURIComponent(id)}`;
    const identity = Session.parse(await request(endpoint, path, selection.directory));
    if (identity.id !== id || identity.parentID !== parentID || identity.directory !== selection.directory) {
      throw fail('notice_recovery_failed_tree_invalid');
    }
    const messages = z.array(Message).min(1).parse(await request(endpoint, `${path}/message`, selection.directory));
    const children = z.array(Session).parse(await request(endpoint, `${path}/children`, selection.directory));
    if (children.some(child => child.parentID !== id || child.directory !== selection.directory)) {
      throw fail('notice_recovery_failed_tree_invalid');
    }
    const proof = { sessionID: id, ...(parentID ? { parentID } : {}), directory: selection.directory,
      ...completed(messages), transcriptDigest: hash(messages), children: children.map(child => child.id).sort() };
    nodes.push({ proof, messages });
    for (const child of children) await visit(child.id, id, depth + 1);
  }
  await visit(selection.sessionID, undefined, 0);
  nodes.sort((left, right) => left.proof.sessionID.localeCompare(right.proof.sessionID));
  return { treeDigest: hash(nodes.map(node => node.proof)), nodes };
}

function failedCall(selection, tree) {
  const failures = [];
  const calls = new Set();
  for (const node of tree.nodes) {
    for (const message of node.messages) {
      for (const raw of message.parts) {
        if (raw?.type !== 'tool') continue;
        const part = ToolPart.parse(raw);
        const key = `${part.sessionID}:${part.callID}`;
        if (message.info.role !== 'assistant' || part.sessionID !== node.proof.sessionID
          || part.messageID !== message.info.id || part.state.time.end < part.state.time.start || calls.has(key)) {
          throw fail('notice_recovery_failed_call_invalid');
        }
        calls.add(key);
        if (part.state.status === 'error') failures.push({ node, message, part });
      }
    }
  }
  const failure = failures[0];
  if (failures.length !== 1 || !failure) throw fail('notice_recovery_failed_call_unproven');
  const { node, message, part } = failure;
  if (node.proof.sessionID === selection.sessionID || node.proof.sessionID !== selection.toolSessionID
    || message.info.id !== selection.messageID || message.info.parentID !== node.proof.userID
    || part.callID !== selection.callID || part.tool !== 'apply_patch'
    || !part.state.error?.startsWith('apply_patch verification failed: Error: Failed to find expected lines in ')
    || part.state.time.end >= node.messages.at(-1).info.time.completed) {
    throw fail('notice_recovery_failed_call_unproven');
  }
  return { partID: part.id, userID: node.proof.userID, failedAt: part.state.time.end, errorDigest: hash(part.state.error) };
}

export async function proveFailedTool(selection, expectedOld, endpoint, request) {
  if (expectedOld !== FAILED_TOOL_BUILD) throw fail('notice_recovery_failed_build_unsupported');
  const health = await request(endpoint, '/global/health', selection.directory);
  if (health?.healthy !== true || health.version !== FAILED_TOOL_OPENCODE) {
    throw fail('notice_recovery_failed_runtime_unsupported');
  }
  const tree = await readFailedToolTree(selection, endpoint, request);
  if (tree.treeDigest !== selection.treeDigest) throw fail('notice_recovery_failed_tree_changed');
  return FailedToolProof.parse({ selection, sessions: tree.nodes.map(node => node.proof), ...failedCall(selection, tree) });
}
