# “Taco-bell orchestration”: reusable agents, different recipes

Living document. Rationale: [ADR-0004](../adr/0004-compose-bounded-maintenance-agents.md).
Contracts: [investigation-packet](../specs/investigation-packet.md).

## Overview

Small agents expose reusable contracts so different applications can compose them into useful workflows.

## Design

Brian's observation: with a collection of small agents, multiple orchestration
tools can mix and match the same ingredients to achieve different outcomes.

An agent owns one bounded task. An orchestrator owns the workflow that invokes
it. A new workflow should be able to reuse an agent's public contract without
inheriting the original workflow's UI, scheduler, storage layout, or conversation.
Different orchestrators may choose different recipes while preserving each
ingredient's responsibility and authority.

The [broader roadmap vision](../plans/roadmap.md#broader-vision--domain-focused-agent-teams)
applies this operating pattern to domain-specific teams, including possible homelab
maintenance. Reuse contracts and orchestration principles while keeping each
agent's capabilities, permissions, and evidence requirements specific to its job.

### Ownership boundaries

| Component | Owns |
| --- | --- |
| Agent | Task-specific judgment, bounded context/tools, validated result or explicit failure |
| Shared contract | Versioned inputs/outputs, evidence, source revision, run identity, provenance |
| Orchestrator/application | Selection, sequencing, eligibility, source acquisition, provider/model choice, budgets, retry policy, approvals, next action |
| Consumer | Presentation and use of the resulting artifacts |

The agent runtime still enforces its own hard limits and validates evidence;
orchestrators may impose tighter budgets. Orchestration does not grant an agent
new tools or turn a candidate location into a diagnosis. Retries and new inputs
produce attributable attempts, not silently overwritten judgments.

Pass artifacts rather than shared conversations. Preserve parent run IDs, issue
hashes, pinned commits, prompt/runtime identities, and failure outcomes across
handoffs. The provider and model remain explicit at the application edge.

### Example recipes

- **Maintainer inbox (implemented):** assess a report's readiness → for selected
  ready bugs, locate code and tests → show the maintainer evidence and questions.
- **Contributor investigation packet (implemented):** choose an issue → assess or
  reuse matching readiness → locate code/tests when eligible → export a concise
  Markdown brief and its JSON evidence/provenance for a contributor.
- **Release investigation (future):** a caller selects reported regressions →
  reuse readiness/location agents → collect investigation leads for maintainer
  review. This does not make either existing agent decide release inclusion,
  severity, or whether a regression is confirmed.

These recipes illustrate reuse; they are not a commitment to build a universal
orchestrator. The current inbox and CLI are consumers/adapters, and the existing
`triage` and `locateCode` functions are the starting points for direct invocation.
The inbox-specific dispatcher is one workflow, not the definition of code-location.
The first external integration uses Codex through a
[local MCP adapter](../specs/mcp-adapter.md), following
[ADR-0006](../adr/0006-prove-composition-through-local-mcp.md). It invokes readiness
and inspects the same assessment and common events. The
[proof report](../plans/records/external-composition-2026-09-18.md) records a successful
live handoff and the preceding approval-configuration failure.

### Bounded multi-issue recipe

The [readiness workflow](../specs/readiness-workflow.md) processes up to five supplied
snapshots in caller order. It shares the MCP process's admission allowance with
single calls and other workflows, and exposes explicit per-issue partial outcomes.
It is ordinary orchestration around the unchanged readiness agent. The caller
still owns selection and any next action; it gains no GitHub write authority.
[ADR-0007](../adr/0007-bound-a-multi-issue-readiness-workflow.md) records the decision;
[backlog Phase 4](../plans/backlog.md#phase-4--bounded-multi-issue-recipe) tracks delivery.

### Explicit ready-to-location handoff

The [location handoff](../specs/location-handoff.md) adds a consumer-selected second
step. The host resolves a saved ready run and operator-pinned checkout; the model
passes a run ID. Source acquisition stays with the operator. Both agents consume
one shared allowance, and the handoff exposes reused readiness separately from new
location work. See [ADR-0008](../adr/0008-handoff-ready-assessments-to-pinned-source-location.md)
and [backlog Phase 5](../plans/backlog.md#phase-5--two-agent-handoff-under-shared-admission).

### Second-consumer proof of concept

The [portable investigation-packet command](../specs/investigation-packet.md) uses the same
two agents and contracts as a small application workflow with explicit inputs
and bounds:

1. Accept one issue snapshot and a caller-selected repository commit/source.
   Invoke readiness or reuse a validated matching result.
2. Dispatch code-location only for a ready bug. For other outcomes, carry forward
   the classification or proposed questions without implying project acceptance.
3. Produce Markdown for a person and JSON for another orchestration tool, with
   citations, uncertainties, parent identities, and explicit partial/failure states.
4. Demonstrate reuse without depending on inbox files or HTML. Preserve inspectable
   records and verify that presentation adds no unsupported claims.

The packet is a deterministic rendering of existing artifacts; it does not need
a third model-powered agent to rewrite them. Transport/server/plugin packaging
can wait for an actual external consumer's requirements.

The [Terra-only pilot](../plans/records/packet-pilot-2026-09-18.md) ran five reports not previously
used to tune code-location and repeated two eligible location runs. All seven
packets completed, with 21 exact source citations. One fresh readiness assessment
withheld location; test selection varied on a broader browser-focus report. The
assistant's development review is separate from independent maintainer acceptance.
The known ACP-path limitation from the
[search follow-up](../plans/records/code-location-search-2026-09-18.md) also remains.

Success means a second useful output consumes the same bounded agent results,
handoffs remain traceable, and quality limits remain visible. Larger coordination
infrastructure and broader agent authority require separate evidence of need.

## Operational notes

The inbox, packet, and Codex MCP adapter consume the same bounded agents. The
MCP adapter exposes readiness plus optional pinned-source location, with operator-selected provider/model and
per-process admission limits. Preserve provenance and explicit failures across
every handoff. Delivery is tracked in [backlog Phase 3](../plans/backlog.md#phase-3--prove-external-composition-implemented).

## References

- Rationale: [ADR-0004](../adr/0004-compose-bounded-maintenance-agents.md).
- Context: [agent design](agents.md).
- Contracts: [readiness](../specs/bug-readiness.md), [code-location](../specs/code-location.md),
  [packet](../specs/investigation-packet.md), [inbox](../specs/inbox.md),
  [batch evaluation](../specs/batch-evaluation.md).
- Built in: [roadmap](../plans/roadmap.md#phase-4--portable-composition).
- Evidence: [evaluation plan](../plans/evaluations.md).

Follow-through: [ADR-0005](../adr/0005-test-relevance-and-portable-agent-discovery.md),
[discovery contract](../specs/agent-discovery.md), and [backlog](../plans/backlog.md).
