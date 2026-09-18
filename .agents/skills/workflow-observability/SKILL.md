---
name: workflow-observability
description: Design or extend common Onionsoup workflow events, trace correlation, and artifact inspection across agents and consumers.
---

# Make a complete workflow inspectable

## Steps

1. Start from an operational question: which stage stopped, which result was reused, or where usage accrued. Reuse existing packet/run/parent identities.
2. Specify a versioned event envelope, ordering, timestamp provenance, agent/version references, lifecycle outcomes, and missing-data rules. Keep input revisions and source commits traceable without copying raw content.
3. Prefer a derived view of validated records until live event delivery is actually needed. Mark unfinished states as unknown; do not synthesize successful tool actions from plausible output.
4. Separate invocation usage from historical reused usage. Keep unknown counts/cost unknown and distinguish completion, grounding, semantic usefulness, and independent acceptance.
5. Test partial records, failure, reuse, stable export ordering, and omission of issue text, source quotes, prompts, and transport errors. Document whether events are snapshots or durable journal entries.

## Pitfalls

- A common event format is not another source of workflow truth.
- Export only allowlisted metadata; unstructured failure strings can contain sensitive provider details.
- Choose an observability backend only when needed; verify its current conventions before adopting them.

Follow the [backlog](../../../docs/plans/backlog.md) and
[agent design](../../../docs/design/agents.md). For current discovery/export work,
read the [public contract](../../../docs/specs/agent-discovery.md).
Validate implementation changes with `npm run verify`; keep scope and permissions
within the user's request.

Adapted from [20-factor: 15-full-spectrum-observability](https://github.com/trentas/20-factor/blob/6dc491097d016c9871c32bd214431f0079673533/_projects/15-full-spectrum-observability.md),
with Onionsoup-specific boundaries and deferred-adoption criteria. This skill text
is licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
