# 0009 — Produce an on-demand bounded maintenance briefing

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

The existing agents, readiness workflow, and saved-parent location handoff are
proven through external consumers. A maintainer still needs a practical command
that captures reports and produces one readable summary without grading evals.

## Decision

Add an on-demand CLI consumer: capture up to five issue snapshots, pin an existing
checkout's commit, assess readiness, then locate code for the first two ready
reports in captured order. Use one seven-invocation allowance for the entire run.
Selection is deterministic capacity allocation, not severity or acceptance judgment.

Compose the existing callable workflows without another model-powered supervisor.
Persist a private root record with intake provenance and original child records.
Render Markdown and correlated metadata-only events from it. Provide a model-free
render command. Reject existing output directories rather than overwrite attempts.

Default intake considers at most 100 recently updated API entries and selects
open non-PR issues. Explicit issue numbers preserve caller order and can include
closed reports. Oversized or unavailable requested reports remain visible as intake
rejections; do not truncate them. The operator owns checkout acquisition; resolve
HEAD or a supplied full commit once and validate origin before inference.

## Consequences

One command yields findings, questions, citations, failures, and unattempted work.
Comments are excluded and counted. Partial results remain useful and inspectable.
A seven-invocation limit is not a cost/quota cap; per-agent bounds still apply.
There is no scheduler, autonomous posting, source execution, source fetching,
resume, cross-process quota, or broader agent authority. The briefing is a consumer,
not a third agent.

## Alternatives considered

- **A model-written synthesis:** adds an avoidable opportunity for unsupported claims.
- **A universal workflow engine:** unnecessary for this fixed useful recipe.
- **Reuse evaluation-batch storage:** operational intake has no gold labels or grading requirement.

## References

- Builds on: [ADR-0007](0007-bound-a-multi-issue-readiness-workflow.md),
  [ADR-0008](0008-handoff-ready-assessments-to-pinned-source-location.md).
- Shapes: [composition](../design/composable-agents.md),
  [briefing contract](../specs/maintenance-briefing.md), [backlog](../plans/backlog.md).
