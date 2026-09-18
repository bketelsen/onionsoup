# 0005 — Explicit test relevance and portable agent discovery

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

Exact source citations have not guaranteed relevant test selection. The next
consumer also needs to discover agents and inspect a workflow without knowing
inbox-specific storage. The repository owner authorized test relevance, capability
manifests, and common workflow events after reviewing the twelve- and twenty-factor
recommendations.

## Decision

Introduce code-location run/brief v3. Each selected test declares model-assessed
`direct` or `adjacent` relevance; a separate bounded-search status distinguishes
`completed` from `unfinished` and explains the limitation. These are judgments,
not execution or coverage proofs. Keep v1/v2 records unchanged and readable.

Publish versioned capability manifests for the two existing agents, including
machine-readable input/result schemas, invocation details, effects, limits, and
failure semantics. Derive schemas and limits from implementation and check the
published artifacts for drift. Repository authoring skills remain separate.

Derive a common, versioned workflow event view from validated persisted artifacts.
Use existing workflow/run identities and provenance, explicitly distinguish reused
runs from newly executed work, and represent incomplete outcomes honestly. Events
are an inspection/export interface, not a second scheduler, mutation authority,
per-step journal, or durable-resume guarantee.

## Consequences

- Consumers can discover contracts and follow workflow outcomes without a new
  service or shared conversation.
- Relevance labels need evaluation; schema validation proves consistency only.
- Historical outputs retain their original meaning and have no invented labels.
- Event exports expose metadata, not issue bodies, source excerpts, or credentials.

## Alternatives considered

- Infer coverage from assertion syntax: rejects useful languages and cannot prove
  semantic relevance. Rejected.
- Introduce a supervisor, registry service, or mandatory transport protocol now:
  unnecessary to prove portable contracts. Deferred.
- Rewrite historical results into the new schema: loses original judgments.
  Rejected.

## References

- Builds on: [ADR-0004](0004-compose-bounded-maintenance-agents.md).
- Shapes: [agent design](../design/agents.md),
  [composition](../design/composable-agents.md), [validation](../design/validation.md),
  [code-location](../specs/code-location.md),
  [capabilities and workflow events](../specs/agent-discovery.md).
- Delivery: [backlog](../plans/backlog.md), [roadmap](../plans/roadmap.md),
  [evaluation plan](../plans/evaluations.md).
