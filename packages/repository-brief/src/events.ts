import { z } from 'zod';
import { hash, validateRepoAgentRun } from '@onionsoup/repository-analysis';
import { WorkflowEvent, WorkflowEventExport, usage } from '@onionsoup/runtime/events';
import { validateRepositoryBrief, stageAgent } from './record.ts';
export function workflowEvents(raw: unknown) {
 const candidate = raw as Record<string, unknown>;
    const b = candidate?.kind === 'repository-brief' ? validateRepositoryBrief(raw) : undefined;
    const standalone = b ? undefined : validateRepoAgentRun(raw);
    const workflowId = b?.workflowId ?? standalone!.runId, events: WorkflowEvent[] = [];
    const add = (e: Omit<WorkflowEvent,'schemaVersion'|'workflowId'|'sequence'>) => {
      events.push(WorkflowEvent.parse({ ...e, schemaVersion: 1, workflowId, sequence: events.length }));
    };
    const append = (r: ReturnType<typeof validateRepoAgentRun>, stageKey?: WorkflowEvent['stageKey']) => {
      const base = { stageKey, agent: r.agent, runId: r.runId, inputHash: r.inputHash, promptVersion: r.promptVersion,
        recordVersion: r.schemaVersion, provider: r.provider, model: r.model };
      add({ ...base, type: 'agent.started', at: r.startedAt });
      for (const e of r.events) {
        const type = e.type === 'stepStart' ? 'agent.step_started' : e.type === 'stepFinish' ? 'agent.step_finished' : e.type === 'toolInputStart' ? 'agent.tool_requested' : undefined;
        if (type && z.iso.datetime().safeParse(e.at).success) add({ ...base, type, at: e.at, step: e.step,
          tool: e.tool === 'submit_result' ? 'submit_result' : undefined });
      }
      add({ ...base, type: r.status === 'running' ? 'agent.unfinished' : r.status === 'completed' ? 'agent.completed' : 'agent.failed',
        at: r.finishedAt ?? r.events.at(-1)?.at ?? r.startedAt, failure: r.failure,
        usage: usage(r.tokenUsage?.totals) });
    };
    add({ type: 'workflow.started', at: b?.startedAt ?? standalone!.startedAt,
      ...(b ? { budget: { limit: 4, consumed: 0, remaining: 4 } } : {}) });
    if (b) {
      add({ type: b.snapshot ? 'stage.completed' : b.failure ? 'stage.failed' : 'stage.unfinished', stageKey: 'collection',
        at: b.snapshot?.finishedAt ?? b.finishedAt ?? b.startedAt, inputHash: b.snapshotHash ?? hash(b.request) });
      for (const stage of b.stages) {
        const base = { stageKey: stage.key, agent: stageAgent[stage.key], at: stage.updatedAt };
        if (stage.reservation) add({ ...base, type: 'workflow.budget_reserved', at: stage.reservedAt!, budget: stage.reservation });
        if (stage.run) append(stage.run,stage.key);
        else add({ ...base, type: stage.status === 'failed' ? 'stage.failed' : stage.status === 'not_attempted' ? 'stage.skipped' : 'stage.unfinished',
          ...(stage.status === 'failed' ? { failure: 'execution_error' as const } : { reason: stage.reason as 'no_data'|'disabled'|'cancelled'|'prior_attempt_unfinished'|undefined ?? 'not_started' }) });
      }
      add({ type: b.status === 'running' ? 'workflow.unfinished' : `workflow.${b.status}`, at: b.finishedAt ?? events.at(-1)!.at, budget: b.budget });
    } else { append(standalone!); add({ type: standalone!.status === 'running' ? 'workflow.unfinished' : `workflow.${standalone!.status}`, at: standalone!.finishedAt ?? events.at(-1)!.at }); }
    return WorkflowEventExport.parse({ schemaVersion: 1, kind: 'workflow-events', mode: 'derived-snapshot', workflowId, events });
}
