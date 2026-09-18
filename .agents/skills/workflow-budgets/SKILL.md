---
name: workflow-budgets
description: Add or change aggregate Onionsoup workflow admission and usage budgets across agents, retries, and concurrent work.
---

# Bound the whole workflow

## Steps

1. Identify the parent workflow and the resource to constrain: calls, logical steps, elapsed time, tokens, or monetary spending. State what the provider actually measures and enforces.
2. Retain per-agent hard limits and add a parent allowance. Reserve capacity before admitting child work; retries consume the same allowance and cannot create a fresh budget.
3. Define behavior for exhaustion, cancellation, missing usage, in-flight requests, and concurrency. A post-response cost counter alone is not a hard spending limit.
4. Keep subscription quota and estimated dollar cost separate. Do not infer free usage from missing cost fields or introduce automatic provider/model fallback.
5. Test fan-out and retry exhaustion, concurrent reservation, cancellation, and unknown provider usage. Expose remaining/consumed allowance through workflow events.

## Pitfalls

- This is deferred infrastructure until the requested workflow needs aggregate control.
- Do not build model routing or comparison machinery as a side effect; current development evaluations remain Terra-only.
- A cooperative deadline depends on abort support; describe overshoot honestly.

Follow the [backlog](../../../docs/plans/backlog.md) and
[agent design](../../../docs/design/agents.md). For current discovery/export work,
read the [public contract](../../../docs/specs/agent-discovery.md).
Validate implementation changes with `npm run verify`; keep scope and permissions
within the user's request.

Adapted from [20-factor: 20-ai-economics-cost-architecture](https://github.com/trentas/20-factor/blob/6dc491097d016c9871c32bd214431f0079673533/_projects/20-ai-economics-cost-architecture.md),
with Onionsoup-specific boundaries and deferred-adoption criteria. This skill text
is licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
