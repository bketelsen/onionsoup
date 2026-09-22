import { createHash, randomUUID } from 'node:crypto';
import { Agent, defineToolInterface, maxSteps, startState, toolCompleted } from '@humanlayer/agentlayer-core';
import type { AgentState, TokenUsage, ToolInterface, Tool } from '@humanlayer/agentlayer-core';
import type { LanguageModel } from 'ai';
import { Assessment, IssueSnapshot, validateAssessment } from './contracts.ts';
import { PROMPT_VERSION, SYSTEM_PROMPT } from './prompt.ts';

export const LIMITS = { steps: 3, timeoutMs: 180000 } as const;
export const SubmitAssessment: ToolInterface<Assessment, string> = defineToolInterface<Assessment, string>({
  name: 'submit_assessment',
  description: 'Submit a grounded bug-report readiness assessment. This only returns data to the caller.',
  input: Assessment,
});

export type TraceEvent = { type: string; at: string; step?: number; tool?: string };
export type RunRecord = {
  schemaVersion: 2; runId: string; agent: 'bug-readiness'; promptVersion: string;
  inputHash: string; input: IssueSnapshot; provider: string; model: string;
  status: 'running' | 'completed' | 'failed'; startedAt: string; finishedAt?: string;
  limits: typeof LIMITS; events: TraceEvent[]; assessment?: Assessment;
  finishReason?: string; failure?: string; tokenUsage?: TokenUsage; state?: AgentState;
};

export function inputHash(input: IssueSnapshot): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export async function triage(raw: unknown, options: {
  model: LanguageModel; provider: string; modelId: string;
  signal?: AbortSignal; checkpoint?: (record: RunRecord) => Promise<void>;
}): Promise<RunRecord> {
  const input = IssueSnapshot.parse(raw);
  const record: RunRecord = {
    schemaVersion: 2, runId: randomUUID(), agent: 'bug-readiness',
    promptVersion: PROMPT_VERSION, inputHash: inputHash(input), input,
    provider: options.provider, model: options.modelId, status: 'running',
    startedAt: new Date().toISOString(), limits: LIMITS, events: [],
  };
  // Persist admission before spending tokens. Checkpoint errors must stop execution.
  await options.checkpoint?.(structuredClone(record));
  let accepted: Assessment | undefined;
  const tool: Tool<Assessment, string> = SubmitAssessment.define(async rawAssessment => {
    if (accepted) throw new Error('ALREADY_SUBMITTED: only one assessment per run');
    accepted = validateAssessment(rawAssessment, input);
    return 'Assessment accepted';
  });
  const agent = new Agent<Record<string, Tool<Assessment, string>>>({
    model: options.model, system: SYSTEM_PROMPT,
    tools: { submit_assessment: tool }, toolChoice: 'required',
    maxSteps: LIMITS.steps, stopWhen: [toolCompleted('submit_assessment'), maxSteps(LIMITS.steps)],
  });
  const timeout = AbortSignal.timeout(LIMITS.timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const run = agent.run({
    state: startState([{ role: 'user', content: JSON.stringify({ issue_snapshot: input }) }]),
    signal, stream: true,
  });
  for await (const event of run) {
    if (event.type === 'stepStart' || event.type === 'stepFinish' || event.type === 'toolInputStart') {
      record.events.push({ type: event.type, at: new Date().toISOString(),
        step: 'stepIndex' in event ? event.stepIndex : undefined,
        tool: 'toolName' in event ? event.toolName : undefined });
    }
  }
  const result = await run.result;
  record.state = result.state;
  record.tokenUsage = result.tokenUsage;
  record.finishReason = result.finishReason;
  record.finishedAt = new Date().toISOString();
  if (accepted && result.finishReason === 'stopCondition' && result.stopCondition?.name === 'toolCompleted:submit_assessment') {
    record.status = 'completed';
    record.assessment = accepted;
  } else {
    record.status = 'failed';
    // Do not put raw transport errors, headers, or credentials in the public result.
    record.failure = signal.aborted ? 'interrupted_or_timed_out' :
      result.finishReason === 'error' ? 'provider_error' : 'no_valid_assessment';
  }
  await options.checkpoint?.(structuredClone(record));
  return record;
}
