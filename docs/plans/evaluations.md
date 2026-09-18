# Plan: Evaluation evidence and next qualification

Status as of 2026-09-18. This plan connects historical experiments to the
[roadmap](roadmap.md) without treating software checks, citation validity, or
assistant review as independent maintainer acceptance. Raw records stay local;
the linked reports publish methods, observed outcomes, and limits.

## Phase 1 — Establish readiness evidence

- Delivered: synthetic checks, initial real-issue trials, and a frozen batch under
  the [readiness contract](../specs/bug-readiness.md),
  [batch workflow](../specs/batch-evaluation.md), and
  [validation design](../design/validation.md).
- Evidence: [first real-issue pilot](records/bb-pilot-2026-09-18.md),
  [Terra comparison](records/terra-comparison-2026-09-18.md), and
  [held-out Terra/Luna batch](records/bb-heldout-2026-09-18.md).
- **Done when:** runtime outcomes and human review are recorded separately against
  frozen inputs. Evidence exists; human review of the full historical batch is
  incomplete. Those comparisons remain historical; new development runs use Terra.

## Phase 2 — Exercise the maintainer workflow

- Delivered: request-kind/readiness separation and the local
  [inbox](../specs/inbox.md), following [agent design](../design/agents.md).
- Evidence: [inbox pilot](records/inbox-pilot-2026-09-18.md) and the separate
  [local-provider exploration](records/local-server-evaluation-2026-09-18.md).
- **Done when:** refresh, reuse, changed inputs, and failure visibility are
  observable in persisted results without GitHub writes. Implemented and exercised;
  local inference exploration is now deferred, not the active evaluation policy.

## Phase 3 — Exercise source location and a second consumer

- Delivered: [location](../specs/code-location.md),
  [portable packets](../specs/investigation-packet.md), and bounded test navigation,
  following [composition design](../design/composable-agents.md) and
  [validation design](../design/validation.md).
- Evidence: [location pilot](records/code-location-pilot-2026-09-18.md),
  [search follow-up](records/code-location-search-2026-09-18.md),
  [packet pilot](records/packet-pilot-2026-09-18.md),
  [fixture-to-assertion follow-up](records/test-selection-2026-09-18.md), and
  [bounded reliability pass](records/reliability-2026-09-18.md).
- **Done when:** accepted citations can be checked against pinned source and
  failures, repeat variation, and weak selections remain visible. Demonstrated in
  small development trials. The latest report includes a failed attempt and weak
  test relevance; this is not broad reliability qualification.

## Phase 4 — Test relevance qualification (planned)

- Design a small frozen trial separating direct coverage, adjacent evidence, and
  unfinished search. Record expectations before changing prompts; reserve fresh
  cases to detect overfitting to the existing trials.
- Extend [validation design](../design/validation.md) and the
  [location contract](../specs/code-location.md) alongside implementation, following
  [roadmap Phase 5](roadmap.md#phase-5--explicit-test-relevance-planned).
- **Done when:** the report separates completion, grounding, test relevance, and
  unsupported claims, retains every attempt, and states whether a narrow change
  helped. Assistant development review must be labeled as such; independent
  maintainer acceptance remains a distinct measurement.

## Later / ideas

Model-comparison infrastructure, new local-provider batches, broader source
corpora, and external orchestrator qualification are deferred until the current
boundary is useful enough to justify them.

## Open questions

Before Phase 4, agree on test relevance categories and the evidence each requires.
The current contract has no direct/adjacent/unfinished classification; add one only
with an explicit contract decision and compatibility plan.

## References

- Rationale: [ADR-0003](../adr/0003-adopt-agentic-template-retroactively.md),
  [ADR-0004](../adr/0004-compose-bounded-maintenance-agents.md).
- Context: [validation](../design/validation.md), [agents](../design/agents.md),
  [composable agents](../design/composable-agents.md).
- Contracts: [readiness](../specs/bug-readiness.md),
  [batch evaluation](../specs/batch-evaluation.md), [inbox](../specs/inbox.md),
  [location](../specs/code-location.md), [packet](../specs/investigation-packet.md).
