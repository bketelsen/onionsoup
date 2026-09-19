# 0014 — Draft read-only proposals from frozen evidence

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

The shared bug/feature pipeline needs a useful first artifact before execution.
Existing bug location is deliberately ineligible for feature requests. A source
search can identify reading leads without establishing implementation relevance.

## Decision

Use two callable focused agents: `feature-requirements` extracts a requirements
brief; `change-proposal` drafts the common proposal. A deterministic recipe freezes
one validated packet, preserving its issue classification and pinned commit. Bugs
reuse inspected packet citations. Features use an operator-selected literal query
and at most three source reads through the existing bounded Git adapter. These
excerpts are search leads, not a feature-location agent's relevance judgment.

Both paths submit evidence-linked criteria, checks, constraints and open decisions.
The host records acceptance as `not_recorded` and verification as `not_executed`.
Proposed scope remains explicitly proposed. Unknown or conflicting requirements
may yield `needs_information`; successful execution is not scope acceptance.

Persist admission and each stage reservation before inference. Allow at most two
agent invocations, three model steps per invocation, and a 240-second recipe
limit. Stop on child failure, interruption or storage failure. Do not auto-replay.
Expose the recipe through a CLI and a deduplicated local console action tied to
an exact parent packet and job revision. No execution, patching or remote writes.

## Consequences

Bugs and features share one proposal worker without weakening existing contracts.
Evidence references and criterion coverage are mechanically checked; support and
usefulness still require semantic review. Literal search is cheap and inspectable,
but may miss relevant code. Missing source context blocks a ready proposal. New
attempts require explicit invocation; no resume infrastructure is introduced.

## Alternatives considered

- **Generalize the bug locator:** rejected because it would erase its ready-bug boundary.
- **Build a feature exploration agent immediately:** deferred until literal search
  proves insufficient for the proposal experiment.
- **Start patching:** deferred until an isolated runner and execution policy exist.

## References

- Builds on: [ADR-0013](0013-converge-bugs-and-features-on-a-shared-change-proposal.md).
- Shapes: [change workflow design](../design/investigation-to-pr.md),
  [proposal contract](../specs/change-proposal.md),
  [implementation plan](../plans/investigation-to-pr.md).
