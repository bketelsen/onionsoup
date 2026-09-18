---
name: agent-quality-review
description: Design automated Onionsoup task-quality review with versioned rubrics and calibrated model judgments, separate from deterministic validation.
---

# Automate useful quality feedback

## Steps

1. Define the agent decision and distinct dimensions: completion, exact grounding, relevance, unsupported claims, and independent acceptance. Keep expected judgments outside the generating model's context.
2. Freeze inputs and a task-specific rubric before execution. Include known failures and reserved fresh cases; retain all attempts and declare development reuse.
3. Apply deterministic checks where evidence is exact. Use model review only for semantic dimensions, with evidence-backed judgments and explicit abstention on insufficient information.
4. Version judge configuration and rubric. Compare with available human anchors and report disagreement; do not turn a model judge into independent maintainer acceptance or use its confidence as truth.
5. Report changes across repeated attempts and quality dimensions separately from latency/usage. Add observed failures to a clearly labeled development corpus; do not silently contaminate held-out data.

## Pitfalls

- This specializes the existing agent-evaluation skill; it does not replace runtime tests.
- No user grading session is required to gather development evidence. Missing independent acceptance remains unknown.
- New live evaluations, including model-based review, follow the repository's Terra-only policy; never conceal failed attempts.

Follow the [backlog](../../../docs/plans/backlog.md) and
[agent design](../../../docs/design/agents.md). For current discovery/export work,
read the [public contract](../../../docs/specs/agent-discovery.md).
Validate implementation changes with `npm run verify`; keep scope and permissions
within the user's request.

Adapted from [20-factor: 06-evaluation-driven-development](https://github.com/trentas/20-factor/blob/6dc491097d016c9871c32bd214431f0079673533/_projects/06-evaluation-driven-development.md),
with Onionsoup-specific boundaries and deferred-adoption criteria. This skill text
is licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
