# 0010 — Compose a repository brief from bounded evidence

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

P6 proves a fixed recipe around narrow agents. Maintainers also need aggregate
issue/PR themes, activity and CI metrics, contributor arrivals, and a short list
of evidence-linked actions. This requires distinct judgments and exact arithmetic.

## Decision

Add a repository-brief recipe and CLI. Collect bounded, timestamped GitHub evidence
through deterministic read-only functions. Calculate metrics in code. Invoke three
focused capabilities: repository-themes (separately for issues and PRs),
repository-health, and maintenance-actions. Use at most four agent attempts,
explicit Terra subscription selection, and saved child input/result contracts.

Group membership is returned as item IDs; code validates the partition and counts
members. Health statements and action suggestions cite supplied evidence IDs.
The source representation for theme summaries is explicitly titles and labels;
no diff analysis, readiness inference, or whole-backlog coverage is implied.

Package these capabilities as local TypeScript modules with supporting functions,
public discovery manifests and versioned contracts. The recipe owns collection,
sequencing, shared admission and persistence. The CLI translates arguments into
the same recipe request. Saved JSON drives Markdown/HTML and common trace exports.

On-demand local delivery is the implemented adapter. Scheduled email, incoming
webhooks, MQTT and GitHub event adapters remain documented next steps. They will
normalize requests into the recipe and deliver saved results, with delivery identity
and duplicate prevention when actual external effects are added.

## Consequences

Counts remain distinct from judgments and sampled coverage stays visible. Failed
sections do not erase successful collection or other results. This adds three
single-purpose capabilities without broadening readiness or code-location.
GitHub search is not an atomic historical snapshot; capped results, unavailable
sections and indexing limitations must be visible. No scheduler, deployment
service, automatic task retry, durable resume, or GitHub/email write is introduced.

## Alternatives considered

- **One report-writing agent:** combines arithmetic, collection and unrelated judgments.
- **One service/container per agent:** deployment complexity is unsupported by this workload.
- **Adopt a distributed scheduler now:** defer until an actual operational requirement warrants it.

## References

- Builds on: [ADR-0004](0004-compose-bounded-maintenance-agents.md),
  [ADR-0009](0009-produce-a-bounded-maintenance-briefing.md).
- Shapes: [packages and recipes](../design/packages-and-recipes.md),
  [repository brief contract](../specs/repository-brief.md), [backlog P7](../plans/backlog.md).
