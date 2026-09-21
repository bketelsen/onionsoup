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

## Phase 12 — Scheduled brief delivery

- Implement the [scheduled delivery contract](../specs/scheduled-delivery.md) using
  [host adapters](../design/packages-and-recipes.md), following
  [ADR-0011](../adr/0011-separate-scheduled-analysis-from-mail-delivery.md).
- **Done when:** an operator-selected occurrence generates one saved brief, delivery
  retries reuse frozen bytes, and unknown sends require explicit reconciliation.
  This is backlog P8. Local capture is qualified in the
  [delivery trial](records/scheduled-delivery-2026-09-18.md); production mail and
  unattended executions still require operational observation.

## Phase 13 — Operator console

- Implement [local operator controls](../specs/operator-console.md) using the
  [console design](../design/operator-console.md).
- **Done when:** saved briefs, delivery outcomes and issue investigations are
  inspectable in one local inbox, with bounded explicit actions, persisted replay
  identities and parent/child provenance. This is backlog P9; see the
  [console trial](records/operator-console-2026-09-18.md).

## Phase 14 — Investigation toward a change proposal

- Follow the [change-workflow exploration](../design/investigation-to-pr.md) and
  its [staged plan](investigation-to-pr.md), beginning with shared read-only proposals
  for bugs and features under [ADR-0013](../adr/0013-converge-bugs-and-features-on-a-shared-change-proposal.md).
  Distinct preparation paths converge on common patch, verification, review and
  publication workers; verification obligations remain specific to each change kind.
- **Done when:** a maintainer can assess a grounded scope and verification proposal
  before granting workspace, execution or remote-publication authority. Subsequent
  phases have their own observable gates; no repair or PR creation ships with P9.

Implemented: [proposal contract](../specs/change-proposal.md), under
[ADR-0014](../adr/0014-draft-read-only-proposals-from-frozen-evidence.md).
Evidence: [read-only proposal trial](records/change-proposal-2026-09-18.md).

## Phase 15 — Isolated baseline and candidate verification

- Deliver [backlog P11](backlog.md#phase-11--isolated-fixture-verification) and
  [P12](backlog.md#phase-12--scoped-fixture-patches-and-separate-review) under the
  [fixture contract](../specs/fixture-execution.md),
  [design](../design/fixture-execution.md) and
  [ADR-0015](../adr/0015-isolate-fixture-verification-and-scoped-patches.md).
- **Done when:** both owned fixture kinds have correctly classified baselines,
  scope-limited candidates, exact diff reconstruction, passing candidate checks and
  separate model review. Earlier failures and resource-boundary evidence remain
  inspectable. [Trial record](records/fixture-patches-2026-09-19.md).

## Phase 16 — Owned-fixture draft publication

Implement [approved bundles and conservative reconciliation](../design/draft-publication.md) under the [publication contract](../specs/draft-publication.md) and [ADR-0016](../adr/0016-publish-only-approved-fixture-bundles.md).

**Done when:** a bug and feature produce exact-evidence draft PRs in an owned fixture repository, stale approvals and ambiguous responses cannot create extra PRs, and console approval/publication is inspectable. No merge.

Implemented. Evidence: [publication trial](records/draft-publication-2026-09-19.md).

## Phase 17 — First real-project implementation

Use the [owned-project profile](../design/owned-project-changes.md) and [contract](../specs/owned-project-changes.md) to connect model proposals to accepted implementation jobs.

**Done when:** one actual Onionsoup feature reaches an exact-evidence draft PR through the full pipeline, with no external-project writes or merge. See [change-workflow Phase 5](investigation-to-pr.md#phase-5--one-real-owned-project-change).

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

## Phase 18 — Go project trial

- Reuse the [owned-project design](../design/owned-project-changes.md) and
  [Go profile contract](../specs/owned-project-changes.md#go-profile-clippy-bubble-color-v1)
  under [ADR-0018](../adr/0018-separate-project-policy-from-language-verification.md).
- Prove Go compilation, original tests, host acceptance checks, separate review
  and exact draft publication in `bketelsen/clippy`; retain TypeScript compatibility.
- **Done when:** one live Terra candidate passes the Go profile and becomes a draft
  PR through the existing shared publisher, with language-specific receipts and
  original assets/tests unchanged. No merge or broad Go accuracy claim.

Completed. Evidence: [Clippy Go trial](records/clippy-go-trial-2026-09-19.md).

## Phase 19 — Reusable repository profiles

- Separate host repository policy, task evidence and frozen checks under
  [ADR-0019](../adr/0019-bind-repository-policy-separately-from-task-evidence.md),
  the [profile contract](../specs/repository-profiles.md) and
  [project design](../design/owned-project-changes.md).
- Reuse Go provisioning, execution, agents and publication for a second Clippy task.
- **Done when:** a task supplied through reviewed artifacts reaches an exact draft
  PR with committed regression tests, without adding task-specific orchestration
  code; stale policy/environment/checks and weakened original tests are rejected.

Completed. Evidence: [repository profile trial](records/repository-profiles-2026-09-19.md).

## Phase 20 — Reusable TypeScript tasks

- Qualify the [TypeScript adapter](../specs/repository-profiles.md#typescript-adapter)
  under [ADR-0020](../adr/0020-qualify-typescript-tasks-through-the-shared-profile-contract.md)
  and the [shared project design](../design/owned-project-changes.md).
- Exercise a bounded delivery-schedule preview task with committed regression tests,
  fixed typechecking, explicit original test-file coverage and frozen host checks.
- **Done when:** an exact draft uses the same task acceptance/worker/publication
  contracts as Go, all declared checks pass, historical records still validate,
  and mismatched adapters or weakened check coverage fail before model work.

Completed. Evidence: [reusable TypeScript trial](records/typescript-profiles-2026-09-19.md).

## Phase 21 — Reusable packages and thin applications

- Extract repository analysis, the brief recipe and delivery behind public workspace
  exports under [ADR-0022](../adr/0022-package-capabilities-with-thin-host-applications.md).
- Share the implementation across CLI, scheduled worker and bounded MCP delegation;
  preserve existing record versions and legacy commands.
- Enforce [package boundaries](../specs/workspace-packages.md), compile a portable
  release, and prove it works without access to root source or developer dependencies.
- **Done when:** a freshly installed compiled release renders the same saved brief,
  prepares delivery and serves MCP calls; existing workflow checks remain green and
  authority/cancellation/interruption tests pass.

Completed. Evidence: [packaging proof](records/workspace-packages-2026-09-19.md).

## Phase 22 — Read-only TrueNAS evidence

- Reuse the owner's existing server under [ADR-0023](../adr/0023-collect-read-only-truenas-evidence-through-existing-mcp.md).
- Implement [sanitized evidence acquisition](../specs/truenas-evidence.md) in a
  standalone package with a thin CLI, explicit host configuration and scoped TLS.
- **Done when:** the configured server yields a saved bounded observation with
  forced read-only mode, unknown sections stay unknown, credentials remain external,
  and negative authority/cancellation checks pass without regressing the OSS release.
Completed. Evidence: [first-contact qualification](records/truenas-first-contact-2026-09-19.md).

## Phase 23 — SSH container inventory

- Implement Docker, Podman and Incus starters under
  [ADR-0024](../adr/0024-collect-container-inventory-over-bounded-ssh.md) and the
  [inventory contract](../specs/container-inventory.md).
- Preserve account/socket/cluster scope, unknown coverage and strict host-key trust.
- **Done when:** both authorized hosts yield saved observations, absent tools remain
  unavailable rather than zero, and command/cancellation/output bounds pass tests.
Completed. Evidence: [SSH inventory qualification](records/container-inventory-2026-09-19.md).

## Phase 24 — k3s, GitOps and a homelab brief

- Add fixed Kubernetes status reads under
  [ADR-0025](../adr/0025-compose-k3s-and-gitops-observations.md).
- Compose saved NAS, container and cluster observations under the
  [homelab brief contract](../specs/homelab-brief.md), keeping coverage and age visible.
- **Done when:** an authorized live cluster snapshot includes node/pod readiness
  and independent Argo health/sync counts; a saved brief includes all three source
  kinds; negative authority, parsing, provenance and freshness checks pass.
Completed. Evidence: [k3s and brief qualification](records/homelab-brief-2026-09-19.md).

## Phase 25 — Workload triage and homelab MCP

- Implement bounded owner-linked evidence and a single workload triage agent under
  [ADR-0026](../adr/0026-triage-workload-findings-through-bounded-evidence.md).
- Add Attention findings to saved briefs and expose configured jobs through the
  [triage/MCP contract](../specs/workload-triage.md).
- **Done when:** representative fixtures and an authorized live snapshot preserve
  current/historical/unknown distinctions, an external stdio client composes the
  brief, and authority, missing-data, cancellation and persistence tests pass.
Completed. Evidence: [workload triage qualification](records/workload-triage-2026-09-19.md).

## Phase 26 — Workflow owners and model delegation

- Extend owner evidence under [ADR-0027](../adr/0027-observe-workflow-owners-and-prove-model-delegation.md)
  and the [workload v2 contract](../specs/workload-triage.md#workflow-owner-evidence-v2).
- Prove model-selected composition with the [bounded conversational consumer](../specs/homelab-delegation.md).
- **Done when:** Workflow success/failure/missing/stale cases are checked, a fresh
  authorized live assessment uses owner evidence, and an actual model delegates
  investigation and brief composition through stdio MCP with inspectable artifacts.

Completed. Evidence: [Workflow and delegation qualification](records/workflow-delegation-2026-09-20.md).

## Phase 27 — Persistent chat and homelab profile

- Implement [persistent chat](../specs/chat.md) under
  [ADR-0028](../adr/0028-separate-chat-sessions-from-domain-capabilities.md), with
  separate core, domain profile and interactive CLI packages.
- Extend [MCP](../specs/workload-triage.md) with configured source refresh and
  selected-finding inspection using existing deterministic collectors.
- **Done when:** a multi-turn session investigates, explains cited evidence, refreshes
  and composes a brief; restart preserves references and budgets without replay;
  ambiguous, stale, failed and unauthorized cases have explicit outcomes.

Completed. Evidence: [persistent chat qualification](records/chat-2026-09-20.md).

## Phase 28 — Shared capability job host

- Implement the [shared job API](../specs/job-host.md) under
  [ADR-0029](../adr/0029-host-reviewed-capabilities-through-a-shared-job-api.md).
- Connect chat and scheduled repository-brief delivery to the same fixed registry.
- **Done when:** both consumers produce inspectable results through one host;
  schema, ownership, idempotency, persistent budgets, interruption and cancellation
  checks pass; domain contracts and delivery effects retain their existing bounds.

Completed. Evidence: [shared-host qualification](records/shared-host-2026-09-21.md).

## Later / ideas

- Homelab composition: read-only inventory/health over Incus, Podman, Docker,
  Synology and TrueNAS, incorporating the owner's existing TrueNAS MCP server.
  First define allowed resources and evidence contracts; retain the same package,
  recipe and host boundaries described in [the composition design](../design/packages-and-recipes.md#agent-orchestration-and-the-next-domain).
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
