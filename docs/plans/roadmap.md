# Plan: Onionsoup roadmap

Status as of 2026-09-18. This roadmap separates implemented PoC capabilities from
future qualification. The [evaluation plan](evaluations.md) holds the dated
evidence; implementation completion alone does not establish task accuracy.

## Phase 0 — Repository conventions

- Adopt the [repository design](../design/repository-layout.md) and
  [layout contract](../specs/repository-layout.md) through the
  [template adoption plan](template-adoption.md).
- **Done when:** canonical instructions and skills, indexed docs, and the local
  documentation check are committed and available from GitHub.

## Phase 1 — Readiness foundation

- Implemented: one bounded assessment per issue, separate request kind/readiness,
  grounded evidence, focused questions, explicit failure records, subscription
  adapters, and historical v1 compatibility.
- Implements [agent design](../design/agents.md),
  [twelve factors](../design/twelve-factors.md), and
  [readiness contract](../specs/bug-readiness.md).
- **Done when:** a caller can produce and inspect a validated v2 assessment or an
  explicit failed run without granting GitHub mutation authority. Implemented;
  independent accuracy qualification remains separate.

## Phase 2 — Read-only maintainer workflow

- Implemented: bounded issue intake, content freshness, durable attempts, and local
  presentation. No maintainer grading is required to use the inbox.
- Implements [agent design](../design/agents.md), [validation](../design/validation.md),
  [inbox](../specs/inbox.md), and [batch evaluation](../specs/batch-evaluation.md).
- **Done when:** a refresh reuses unchanged reports and presents assessments,
  questions, waiting work, and failures without modifying GitHub. Implemented.

## Phase 3 — Grounded code and test locations

- Implemented: a separate agent, pinned Git source, bounded search/read tools,
  citation validation, test-read reserve, v2 host-generated overviews, and grouped
  correction feedback. Historical v1 records remain readable.
- Implements [agent design](../design/agents.md),
  [validation](../design/validation.md), and
  [code-location contract](../specs/code-location.md).
- **Done when:** ready reports can yield inspectable code/test starting points or
  explicit failures, with all accepted citations tied to inspected source.
  Implemented; useful test selection is not guaranteed by exact citations.

## Phase 4 — Portable composition

- Implemented: a second consumer exports Markdown and JSON using the same two
  agents without depending on inbox storage or UI.
- Implements [composable agents](../design/composable-agents.md),
  [agent design](../design/agents.md), and
  [packet contract](../specs/investigation-packet.md).
- **Done when:** packets preserve original assessment/location records, parent
  identities, uncertainties, and partial failures and can render without a model.
  Implemented; the external consumer proof is recorded in Phase 7.

## Phase 5 — Explicit test relevance

- Implemented: distinguish model-assessed direct relevance, adjacent tests,
  and unfinished test search; avoid presenting a precisely quoted weak test as
  strong coverage. These are v3 result fields, not coverage measurements.
- Extend [agent design](../design/agents.md), [validation](../design/validation.md),
  and [code-location contract](../specs/code-location.md) together under
  [ADR-0005](../adr/0005-test-relevance-and-portable-agent-discovery.md). Use the [evaluation plan](evaluations.md#phase-4--test-relevance-development-trial).
- **Done when:** a frozen, small Terra-only trial reports relevance separately from
  citation validity, preserves failed attempts, and shows whether the change
  improves useful test selection without broadening agent authority.

The [status report](records/relevance-and-discovery-2026-09-18.md) records completed
implementation, the initial 4/7 expected-label match, focused follow-up, and limits.

## Phase 6 — Portable discovery and workflow events

- Implemented: [capability manifests and workflow exports](../specs/agent-discovery.md)
  for the existing agents, following [composition design](../design/composable-agents.md).
- **Done when:** credential-free consumers can discover current schemas, callable
  entry points, effects and limits, and export correlated events from old/new
  artifacts with explicit reuse and unknown outcomes. Implemented; Phase 7 demonstrates an external orchestrator.

## Phase 7 — External consumer proof

- Implemented: Codex through the [local MCP adapter](../specs/mcp-adapter.md),
  following [composition design](../design/composable-agents.md) and
  [ADR-0006](../adr/0006-prove-composition-through-local-mcp.md).
- **Done when:** an actual external consumer discovers an existing agent, invokes
  it, and inspects a traceable result without broadening the agent's contract or
  authority. Demonstrated in the [proof report](records/external-composition-2026-09-18.md).

## Phase 8 — Shared admission and partial outcomes

- Implemented: the [readiness workflow](../specs/readiness-workflow.md), following
  [composition design](../design/composable-agents.md) and
  [ADR-0007](../adr/0007-bound-a-multi-issue-readiness-workflow.md).
- **Done when:** a model consumer invokes three exact prepared snapshots with an
  allowance of two, reports the unattempted third issue, and inspection preserves
  failure/cancellation/persistence boundaries. See the
  [workflow proof](records/multi-issue-workflow-2026-09-18.md).

## Phase 9 — Cross-agent admission and source ownership

- Implemented the [location handoff](../specs/location-handoff.md) following
  [composition design](../design/composable-agents.md) and
  [ADR-0008](../adr/0008-handoff-ready-assessments-to-pinned-source-location.md).
- **Done when:** the external consumer selects a saved ready assessment for pinned
  source location under a shared allowance, and results retain exact source/parent
  identities and truthful partial/failure states. Demonstrated in the
  [two-agent proof](records/two-agent-handoff-2026-09-18.md); this is follow-through backlog P5.

## Phase 10 — On-demand maintenance briefing

- Implemented the [briefing consumer](../specs/maintenance-briefing.md), following
  [composition design](../design/composable-agents.md) and
  [ADR-0009](../adr/0009-produce-a-bounded-maintenance-briefing.md).
- **Done when:** one command captures up to five reports, assesses them and locates
  the first two ready bugs under seven shared admissions, then produces an
  inspectable Markdown briefing without requiring human grading. This is backlog P6.

Demonstrated in the [briefing proof](records/maintenance-briefing-2026-09-18.md).

## Phase 11 — Aggregate repository brief

- Implemented the [repository brief](../specs/repository-brief.md) and local
  [package/recipe boundaries](../design/packages-and-recipes.md), following
  [ADR-0010](../adr/0010-compose-a-repository-brief-from-bounded-evidence.md).
- **Done when:** counts and aggregate themes, CI/contributor health and bounded
  action suggestions are available on demand, with exact arithmetic, visible
  sampling and independently callable agents. This is backlog P7; scheduled
  delivery and event adapters remain future work.

Demonstrated in the [repository brief trial](records/repository-brief-2026-09-18.md),
including the initial date-query defect and corrected follow-up.

## Broader vision — domain-focused agent teams

Recorded on 2026-09-18: OSS maintenance is the first proving ground for Onionsoup,
not the limit of the concept. The same approach could support a homelab team:
separate agents could assess backup evidence, report service health, or propose
bounded maintenance actions. Other domains may have their own focused teams.

Reuse the operating pattern—single-purpose agents, explicit public contracts,
artifact-based handoffs, shared budgets, and inspectable outcomes—while each domain
owns its data sources, authority, and success criteria. A homelab agent that reads
health data and one that changes infrastructure have different responsibilities
and permissions. New domains should start with one useful bounded job and evidence
of value, using the [composition design](../design/composable-agents.md). This note
records the direction; it does not grant the current OSS agents infrastructure
access or broaden their responsibilities.

## Later / ideas

- Extend shared invocation admission to another agent only for a concrete recipe.
- Revisit provider/model comparison as a structured study. Local inference remains
  a reasonable exploration route, currently deferred.
- Add focused agents only when evidence identifies a separate useful job and its
  public contract. Do not turn location into diagnosis or repair.

## Open questions

- Select the next consumer recipe and its bounded workload. The
  [backlog](backlog.md) retains the remaining twelve- and twenty-factor recommendations.
- Independent maintainer acceptance remains unmeasured for some historical trials;
  assistant reviews cannot supply that measurement.

## References

- Rationale: [ADR-0003](../adr/0003-adopt-agentic-template-retroactively.md),
  [ADR-0004](../adr/0004-compose-bounded-maintenance-agents.md).
- Implements: [repository design](../design/repository-layout.md),
  [agent design](../design/agents.md), [validation](../design/validation.md), and
  the contracts linked from each phase.
- Evidence and limits: [evaluation plan](evaluations.md).
