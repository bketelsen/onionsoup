---
name: agent-execution
description: Implement Onionsoup agent control flow, persisted state, bounded recovery, and explicit human handoffs when changing runtime behavior.
---

Make transitions ordinary code. A model chooses among permitted structured intents;
the application decides whether to execute, stop, wait, or reject them. A framework
stop condition is not automatically business success. Require a validated result
and a successful execution outcome before declaring completion.

Keep task data, execution outcome, model messages, and correlation identifiers in
one serializable run record where practical. Derive status from recorded events or
results instead of maintaining a second independent workflow truth. The model
worker should accept explicit state and return new state, without hidden durable
memory in its process.

Enforce finite steps and a wall-clock deadline. Account for provider-level retries
separately from logical model steps. Decide which errors are correctable and which
end the run. Record exhausted, cancelled, failed, and incomplete runs as such.

Persist intent before any external effect. For agents that mutate systems, define
an idempotency key, reconciliation after ambiguous responses, and protection from
concurrent consumers. Do not claim exactly-once effects from a local checkpoint.
Apply this machinery only where the agent actually has effects.

Represent a human question as structured data with the task/run identity, reason,
and requested information. If the workflow waits for an answer, persist the waiting
state and return; resume through a narrow API after validating answer identity and
freshness. Never keep a worker sleeping for a human. For a one-shot assessor, a
needs-information artifact can end the task; reassess a new snapshot when it arrives.

Expose launch and query through simple functions first. Add durable resume only
when a task spans a real wait or meaningful partial work. Document crash boundaries
honestly: a saved initial record plus final record is not per-step recovery.

See [factor mapping](../../../docs/design/twelve-factors.md), factors 5, 6, 7, 8, 9, 12.
Adapted from Dex Horthy / HumanLayer's 12-Factor Agents; this skill text is
licensed CC BY-SA 4.0, with explicit effect and recovery limits added.
