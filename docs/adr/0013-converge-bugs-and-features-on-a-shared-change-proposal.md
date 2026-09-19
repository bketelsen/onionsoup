# 0013 — Converge bugs and features on a shared change proposal

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

The proposed investigation-to-PR workflow starts with bug investigation packets.
The intended product scope also includes feature requests, which need requirements
and acceptance evidence rather than an allegation of defective existing behavior.
Most workspace, candidate, verification, review and publication mechanisms apply
to both. Current feature classification intentionally makes no acceptance decision,
and current code-location only accepts ready bug reports.

## Decision

Give bugs and features distinct preparation paths that converge on a shared,
versioned change proposal. Bug preparation supplies observed/expected behavior,
reproduction evidence, hypotheses and the existing investigation packet. Feature
preparation supplies a requirements brief, acceptance examples, constraints,
non-goals, unresolved product decisions and bounded source context for extension
points. Both feed one focused proposal job: specify a grounded, reviewable change.

Share the downstream workspace/runner adapter, patch agent, verification receipts,
independent review and publication adapter. Select verification obligations by
change kind: bug regression evidence versus feature acceptance and compatibility.
Keep request classification, information sufficiency, maintainer scope acceptance,
and authority to execute/publish separate. Record existing maintainer authorization
when present rather than requesting it redundantly.

This accepts the design direction; implementation remains phased. Preserve current
readiness and code-location contracts. Do not relabel a feature as a ready bug or
invoke the existing bug-only locator with feature input. A future feature-context
capability may reuse the bounded source adapter through its own explicit contract.

## Consequences

Most of the eventual pipeline can be reused with explicit input variants and
verification profiles. Features can stop for missing requirements without being
rejected. Future evaluations must include both paths and negative cases, and
baseline verification must not require features to masquerade as bugs. No current
agent gains write, execution or publication authority from this decision.

## Alternatives considered

- **Run features through bug readiness/location unchanged:** violates current
  contracts and invents a bug-readiness meaning for feature requests.
- **Duplicate the entire PR pipeline:** fragments effect handling, provenance,
  review and verification machinery without a different downstream job.
- **One agent handles intake through PR:** combines product decisions, code work,
  execution and publication across unrelated authority boundaries.

## References

- Builds on: [ADR-0012](0012-operate-saved-workflows-through-a-local-console.md),
  [ADR-0004](0004-compose-bounded-maintenance-agents.md).
- Shapes: [change-workflow design](../design/investigation-to-pr.md),
  [implementation plan](../plans/investigation-to-pr.md),
  [backlog P10](../plans/backlog.md#phase-10--change-proposals-planned).
- Preserves: [readiness](../specs/bug-readiness.md),
  [code-location](../specs/code-location.md),
  [investigation packet](../specs/investigation-packet.md).
