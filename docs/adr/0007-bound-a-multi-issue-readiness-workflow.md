# 0007 — Bound a multi-issue readiness workflow with shared admission

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

Codex has demonstrated one readiness invocation through MCP. A useful next recipe
assesses a short ordered list of issue snapshots and reports incomplete work.
Independent per-call limits do not bound the total work a consumer requests.

## Decision

Add a deterministic readiness workflow for one to five distinct issues. Process
snapshots in supplied order, sequentially, using the unchanged readiness agent.
Single calls and workflows on one MCP process share an invocation allowance.
Reserve before provider initialization and persist workflow admission before
inference. Failures consume capacity; there are no automatic task retries.

Persist incremental workflow snapshots containing child records. Expose explicit
completed, failed, unfinished, and not-attempted item outcomes, along with parent
identity and budget snapshots in common events. Cancellation stops further
admission. Persistence failure stops execution; return only previously saved state.

The live trial showed Codex dropping all issue bodies when asked to copy three
large snapshots into a tool call. Add an optional host-prepared input artifact:
load and validate it once at launch, expose its hash and issue identities, and let
the model select that immutable artifact by hash. Keep direct snapshot submission
for programmatic consumers. Do not rely on prompt instructions for byte fidelity.

## Consequences

A consumer can ask for three issues with capacity for two and inspect exactly
which work remains. This is an invocation bound, not a token, subscription-quota,
or monetary cap. The allowance is process-local and resets on restart. Artifacts
are inspectable but do not imply durable resume. No new agent, provider routing,
GitHub writes, source execution, or human evaluation requirement is introduced.

## Alternatives considered

- **Parallel fan-out:** adds concurrency and cancellation complexity before a
  sequential recipe demonstrates need. Reservation remains synchronous.
- **Reuse the evaluation batch format:** that contract includes frozen evaluation
  criteria and historical model comparison; operational workflows have different
  consumers and outcomes.
- **A durable coordinator:** unnecessary for this bounded read-only recipe.

## References

- Builds on: [ADR-0006](0006-prove-composition-through-local-mcp.md).
- Shapes: [composition](../design/composable-agents.md),
  [readiness workflow](../specs/readiness-workflow.md),
  [MCP adapter](../specs/mcp-adapter.md), [backlog](../plans/backlog.md).
