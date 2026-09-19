# 0008 — Hand off saved ready assessments to pinned source location

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

Phase 4 proved several readiness calls under shared admission. The next concrete
recipe needs the existing second agent: code-location for a selected ready report.
Models must not reconstruct parent evidence or choose arbitrary source paths.

## Decision

Optionally configure one source checkout, repository name, and immutable commit
at MCP launch. A consumer selects a readiness run ID saved in the same process.
The host validates eligibility and repository identity, then constructs the existing
location input from the saved parent and configured source. The unchanged location
agent validates source origin and commit and reads Git blobs without execution.

Use the same invocation allowance as readiness. Persist a location-handoff record
with the reused parent, source identity, budget reservation, child record, and
explicit terminal or incomplete outcome. Expose inspection and common events.
No task retry, source fetching, or automatic readiness-to-location dispatch is added.

## Consequences

An external consumer can compose the two focused agents without copying task
payloads or expanding authority. The host owns acquisition of a suitable checkout.
Missing or invalid source can consume one admitted attempt but cannot cause model
inference on unvalidated source. Reused parent usage is historical. The process
budget still resets on restart; snapshots do not promise resume or exactly-once
execution. Existing packet and readiness-workflow formats remain unchanged.

## Alternatives considered

- **Caller-supplied parent/source arguments:** lets a model reconstruct evidence or
  select filesystem paths unnecessarily.
- **Extend readiness into code search:** erases the existing useful agent boundary.
- **New universal coordinator:** unnecessary for one explicit handoff.

## References

- Builds on: [ADR-0004](0004-compose-bounded-maintenance-agents.md),
  [ADR-0007](0007-bound-a-multi-issue-readiness-workflow.md).
- Shapes: [composition](../design/composable-agents.md),
  [location handoff](../specs/location-handoff.md), [backlog](../plans/backlog.md).
