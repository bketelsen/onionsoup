# Onionsoup documentation

Start with the [agent design](design/agents.md), then the exact contracts below.
The [roadmap](plans/roadmap.md) separates implemented capabilities from planned
work; the [evaluation plan](plans/evaluations.md) indexes the evidence and limits.

Documentation follows [agentic-template](https://github.com/bketelsen/agentic-template)
as recorded in [ADR-0003](adr/0003-adopt-agentic-template-retroactively.md).
Use category templates for new documents and maintain reciprocal links under
[AGENTS.md](../AGENTS.md). Run `npm run check:docs` to validate the local structure.

## Decisions — why

Accepted decisions record rationale; a later decision supersedes an earlier one.

- [0001 — Record architecture decisions](adr/0001-record-architecture-decisions.md)
- [0002 — Agent-portable instruction surface](adr/0002-agent-portable-instruction-surface.md)
- [0003 — Adopt agentic-template without changing agent behavior](adr/0003-adopt-agentic-template-retroactively.md)
- [0004 — Compose bounded maintenance agents through versioned artifacts](adr/0004-compose-bounded-maintenance-agents.md)
- [ADR template](adr/TEMPLATE.md)

## Design — how

Living descriptions of the implemented system.

- [Design template](design/TEMPLATE.md)
- [Focused agents and artifact handoffs](design/agents.md)
- [“Taco-bell orchestration”: reusable agents, different recipes](design/composable-agents.md)
- [Repository layout and instruction discovery](design/repository-layout.md)
- [Twelve factors, applied to Onionsoup](design/twelve-factors.md)
- [Validation record](design/validation.md)

## Specs — exact contracts

Behavioral contract changes accompany implementation.

- [Specs template](specs/TEMPLATE.md)
- [Frozen batch evaluation](specs/batch-evaluation.md)
- [Bug-report readiness contract, version 2](specs/bug-readiness.md)
- [Code-location contract, version 3](specs/code-location.md)
- [Read-only maintenance inbox](specs/inbox.md)
- [Portable investigation packet, version 1](specs/investigation-packet.md)
- [Spec: Repository layout and documentation checks](specs/repository-layout.md)

## Plans — order of work

Phased delivery with observable Done when outcomes.

- [Plans template](plans/TEMPLATE.md)
- [Plan: Evaluation evidence and next qualification](plans/evaluations.md)
- [Plan: Onionsoup roadmap](plans/roadmap.md)
- [Plan: Retroactive template adoption](plans/template-adoption.md)

### Historical evaluation evidence

These dated appendices preserve the findings and versions of each trial.
Raw run links are optional local evidence; those files are intentionally not published.

- [Evaluation record template](plans/records/TEMPLATE.md)
- [Terra/Luna held-out issue evaluation — 2026-09-18](plans/records/bb-heldout-2026-09-18.md)
- [Real-issue pilot: get-bb/bb, 2026-09-18](plans/records/bb-pilot-2026-09-18.md)
- [Code-location pilot — 2026-09-18](plans/records/code-location-pilot-2026-09-18.md)
- [Search and test selection follow-up — 2026-09-18](plans/records/code-location-search-2026-09-18.md)
- [Read-only intake pilot — 2026-09-18](plans/records/inbox-pilot-2026-09-18.md)
- [Local server assessment — 2026-09-18](plans/records/local-server-evaluation-2026-09-18.md)
- [Portable investigation packet pilot — 2026-09-18](plans/records/packet-pilot-2026-09-18.md)
- [Bounded test completion and source-linked overviews — 2026-09-18](plans/records/reliability-2026-09-18.md)
- [Terra comparison, 2026-09-18](plans/records/terra-comparison-2026-09-18.md)
- [Following fixtures to assertions — 2026-09-18](plans/records/test-selection-2026-09-18.md)

- [Aggregate repository brief trial](plans/records/repository-brief-2026-09-18.md)
- [On-demand maintenance briefing proof](plans/records/maintenance-briefing-2026-09-18.md)
- [Two-agent saved-parent handoff proof](plans/records/two-agent-handoff-2026-09-18.md)
- [Bounded multi-issue workflow proof](plans/records/multi-issue-workflow-2026-09-18.md)
- [Codex external composition proof](plans/records/external-composition-2026-09-18.md)
- [Status: relevance, discovery, events, and skills](plans/records/relevance-and-discovery-2026-09-18.md)

## Current follow-through

- [Backlog: twelve- and twenty-factor recommendations](plans/backlog.md)
- [ADR-0005: relevance and portable discovery](adr/0005-test-relevance-and-portable-agent-discovery.md)
- [Capability and workflow-event contract](specs/agent-discovery.md)
- [ADR-0006: external composition through local MCP](adr/0006-prove-composition-through-local-mcp.md)
- [Local MCP adapter contract](specs/mcp-adapter.md)
- [ADR-0007: shared workflow admission](adr/0007-bound-a-multi-issue-readiness-workflow.md)
- [Bounded readiness workflow contract](specs/readiness-workflow.md)
- [ADR-0008: ready-to-location handoff](adr/0008-handoff-ready-assessments-to-pinned-source-location.md)
- [Saved readiness to pinned location contract](specs/location-handoff.md)

- [ADR-0009: on-demand maintenance briefing](adr/0009-produce-a-bounded-maintenance-briefing.md)
- [Maintenance briefing contract](specs/maintenance-briefing.md)

- [ADR-0010: repository brief composition](adr/0010-compose-a-repository-brief-from-bounded-evidence.md)
- [Agent packages, recipes, and adapters](design/packages-and-recipes.md)
- [Repository brief contract](specs/repository-brief.md)

## Related repository material

- [README and commands](../README.md)
- [Canonical contributor instructions](../AGENTS.md)
- [Sources and attribution](../REFERENCES.md)
- [Reusable agent skills](../.agents/skills/)
