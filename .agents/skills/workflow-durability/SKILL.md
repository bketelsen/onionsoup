---
name: workflow-durability
description: Implement durable Onionsoup waits, recovery, and effect reconciliation when a workflow spans real human waits or meaningful partial work.
---

# Persist the workflow at real recovery boundaries

## Steps

1. Identify the actual wait or partial effect that requires recovery. For short read-only jobs, an explicit interrupted attempt and deliberate retry may remain sufficient.
2. Separate deterministic workflow transitions from model calls and external effects. Persist proposed actions before execution and journal observed outcomes without confusing intent with completion.
3. Define stable operation identities and destination-supported idempotency where available. A local result cache cannot close the crash window after a remote effect succeeds but before the cache is written; use reconciliation or surface an unknown outcome.
4. Persist human waits and release the worker. Resume only after validating response identity, authorization, freshness, and workflow version. Do not replay an LLM call when a recorded result should be reused.
5. Test termination before/after effects, duplicate signals, ambiguous responses, and replay of historical journals against a new version. Document unachieved guarantees.

## Pitfalls

- Checkpoints are not an exactly-once guarantee.
- Do not build a durable engine merely because a run has multiple model steps.
- Keep old workflow versions or provide explicit migrations; silent replay under new semantics can duplicate effects.

Follow the [backlog](../../../docs/plans/backlog.md) and
[agent design](../../../docs/design/agents.md). For current discovery/export work,
read the [public contract](../../../docs/specs/agent-discovery.md).
Validate implementation changes with `npm run verify`; keep scope and permissions
within the user's request.

Adapted from [20-factor: 13-durable-agent-runtime](https://github.com/trentas/20-factor/blob/6dc491097d016c9871c32bd214431f0079673533/_projects/13-durable-agent-runtime.md),
with Onionsoup-specific boundaries and deferred-adoption criteria. This skill text
is licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
