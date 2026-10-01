import { tool } from '@opencode-ai/plugin';
import type { OperatorWrites } from './operator-write-host.ts';
import { OperatorWriteCalls, type OperatorFileInput } from './operator-write-call.ts';
import { OPERATOR_WRITE_LIMITS } from './operator-write-workspace.ts';

export function operatorFileTool(writes: OperatorWrites, calls: OperatorWriteCalls): ReturnType<typeof tool> {
  return tool({
    description: 'Replace one explicitly approved existing tracked text file in your bound write task. Supply its exact current SHA256 from the task or previous host receipt, relative path and full new content. No shell, new paths, deletes or commits. Unknown or stale effects refuse; never invent a fresh digest to bypass a refusal.',
    args: { path: tool.schema.string(), expectedBeforeSha256: tool.schema.string().regex(/^[a-f0-9]{64}$/),
      content: tool.schema.string().max(OPERATOR_WRITE_LIMITS.fileBytes) },
    async execute(args, context) {
      const callID = calls.consume(context.sessionID, args as OperatorFileInput & Record<string, unknown>);
      return JSON.stringify(await writes.file(context, callID, args));
    },
  });
}
