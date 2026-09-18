# 0004 — Compose bounded maintenance agents through versioned artifacts

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

This retrospectively records the implemented architecture, rather than adding
agent authority. Earlier monolithic experiments motivated a proof of concept
based on the 12-Factor Agents principles. Readiness and code-location already
serve an inbox and portable investigation packets, with recorded quality limits.

## Decision

Give each agent one bounded decision: assess a report's kind/readiness, or locate
code/tests for a matching ready bug at a pinned commit. Use AgentLayer with
explicit provider/model selection at the application boundary. Current live
development evaluations use Copilot or Codex subscriptions with Terra only.

Let ordinary code own eligibility, identities, validation, budgets, persistence,
and rendering. Consumers exchange versioned artifacts rather than conversations.
Preserve historical outputs and failures. Exact evidence grounding does not prove
semantic relevance. Keep readiness separate from project acceptance and keep
code-location separate from diagnosis, code execution, fixes, and GitHub writes.

## Consequences

- The same focused agents can serve multiple workflows without inheriting an
  inbox's storage or UI.
- Explicit limits sometimes yield partial or failed investigations.
- Public contracts and provenance require care when evolving results.
- Quality review remains necessary; passing scripted tests or citation checks
  does not justify expanding autonomy.

## Alternatives considered

- **One general maintainer agent:** obscures responsibility and makes evaluation
  and effect boundaries harder to inspect. Rejected for this proof of concept.
- **A universal team coordinator first:** adds infrastructure before an actual
  consumer needs it. Deferred.
- **Accept schema-valid output as correct:** contradicted by recorded relevance
  and summary failures. Rejected.

## References

- Builds on: [ADR-0001](0001-record-architecture-decisions.md),
  [ADR-0003](0003-adopt-agentic-template-retroactively.md).
- Shapes designs: [agents](../design/agents.md),
  [factor mapping](../design/twelve-factors.md),
  [composition](../design/composable-agents.md), [validation](../design/validation.md).
- Shapes specs: [readiness](../specs/bug-readiness.md),
  [code-location](../specs/code-location.md), [packets](../specs/investigation-packet.md),
  [inbox](../specs/inbox.md), [batch evaluation](../specs/batch-evaluation.md).
- Shapes plans: [roadmap](../plans/roadmap.md), [evaluations](../plans/evaluations.md).
