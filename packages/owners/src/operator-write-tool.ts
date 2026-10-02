import { tool } from '@opencode-ai/plugin';
import type { OperatorWrites } from './operator-write-host.ts';
import { OperatorWriteCalls, OperatorCheckCalls, type OperatorFileInput, type OperatorCheckInput } from './operator-write-call.ts';
import { OPERATOR_WRITE_LIMITS } from './operator-write-workspace.ts';

export function operatorFileTool(writes: OperatorWrites, calls: OperatorWriteCalls): ReturnType<typeof tool> {
  return tool({
    description: 'Write one explicitly approved text file in your bound write task. Existing files require their current SHA256; an approved new path requires absent and is created exclusively. Supply its exact current SHA256 from the task or previous host receipt, relative path and full new content. No unapproved paths, shell, deletes or commits. Unknown or stale effects refuse; never invent a fresh digest to bypass a refusal.',
    args: { path: tool.schema.string(), expectedBeforeSha256: tool.schema.string().regex(/^(?:[a-f0-9]{64}|absent)$/),
      content: tool.schema.string().max(OPERATOR_WRITE_LIMITS.fileBytes) },
    async execute(args, context) {
      const callID = calls.consume(context.sessionID, args as OperatorFileInput & Record<string, unknown>);
      return JSON.stringify(await writes.file(context, callID, args));
    },
  });
}

export function operatorCheckTool(writes: OperatorWrites, calls: OperatorCheckCalls): ReturnType<typeof tool> {
  return tool({
    description: 'Run a check ID explicitly covered by your write task approval. The host runs its exact approved Node, Go or project command on a private source snapshot. Project commands use host-selected tools in a writable disposable copy with no network, host credentials, production state or original-workspace writes. Results bind the source digest; changed source needs new checks. Never replay an uncertain check.',
    args: { checkID: tool.schema.string() },
    async execute(args, context) {
      const callID = calls.consume(context.sessionID, args as OperatorCheckInput & Record<string, unknown>);
      return JSON.stringify(await writes.check(context, callID, args));
    },
  });
}
