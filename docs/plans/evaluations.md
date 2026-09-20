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

## Phase 4 — Test relevance development trial

- Design a small frozen trial separating direct coverage, adjacent evidence, and
  unfinished search. Record expectations before changing prompts; reserve fresh
  cases to detect overfitting to the existing trials.
- Extend [validation design](../design/validation.md) and the
  [location contract](../specs/code-location.md) alongside implementation, following
  [roadmap Phase 5](roadmap.md#phase-5--explicit-test-relevance).
- **Done when:** the report separates completion, grounding, test relevance, and
  unsupported claims, retains every attempt, and states whether a narrow change
  helped. Assistant development review must be labeled as such; independent
  maintainer acceptance remains a distinct measurement.

The [relevance and discovery report](records/relevance-and-discovery-2026-09-18.md)
records 13 completed live development runs, three preserved label disagreements,
and two focused follow-ups. Contract implementation is complete; broad quality
qualification is not claimed.

## Phase 5 — External consumer integration

- Connect Codex through the [MCP adapter](../specs/mcp-adapter.md), following
  [composition design](../design/composable-agents.md).
- **Done when:** recorded consumer tool calls and final output match the persisted
  agent result and trace, with failures retained. Demonstrated in the
  [external composition report](records/external-composition-2026-09-18.md).
- This is integration evidence, not a new task-accuracy evaluation.

## Phase 6 — Bounded multi-issue consumer

- Exercise the [workflow contract](../specs/readiness-workflow.md) through Codex
  and [MCP](../specs/mcp-adapter.md).
- **Done when:** the exact three frozen snapshots are preserved through a
  two-invocation workflow, the third is explicitly unattempted, and software tests
  cover shared capacity and partial outcomes. Demonstrated in the
  [workflow report](records/multi-issue-workflow-2026-09-18.md), which preserves the
  failed input-copying attempt and successful prepared-input follow-up.

## Phase 7 — Two-agent external handoff

- Exercise the [location handoff](../specs/location-handoff.md) through Codex,
  following [composition](../design/composable-agents.md).
- **Done when:** readiness and location share a two-invocation allowance, preserve
  exact parent/source identities, and produce an inspectable brief with verified
  citations. Demonstrated in the [two-agent report](records/two-agent-handoff-2026-09-18.md).

## Phase 8 — On-demand maintenance briefing

- Exercise the [briefing contract](../specs/maintenance-briefing.md) with Copilot /
  Terra, following [composition](../design/composable-agents.md).
- **Done when:** a small live command preserves exact captured inputs, shared
  reservations and pinned citations, reports skips and failures honestly, and
  renders the same saved output without inference. Assistant review measures
  grounding and practical usefulness separately; no independent accuracy claim.

Demonstrated in the [briefing proof](records/maintenance-briefing-2026-09-18.md).

## Phase 9 — Aggregate repository brief

- Exercise the [repository brief](../specs/repository-brief.md) with Copilot/Terra,
  following [packages and recipes](../design/packages-and-recipes.md).
- **Done when:** a small live recipe preserves API totals versus sample membership,
  contributor-history limits and CI denominators; theme IDs and action references
  validate; assistant review records semantic usefulness separately from runtime
  correctness, without independent acceptance claims.

Demonstrated in the [repository brief trial](records/repository-brief-2026-09-18.md),
including the initial date-query defect and corrected follow-up.

## Phase 10 — Scheduled delivery reliability

- Exercise the [delivery adapter](../specs/scheduled-delivery.md) from
  [packages and recipes](../design/packages-and-recipes.md).
- **Done when:** local SMTP tests prove saved-message delivery, duplicate suppression,
  bounded retries, storage/crash handling, timezone behavior and explicit ambiguous
  outcomes. Reuse a real saved brief for a capture proof without new model calls.
  Record configured scheduling separately from observed unattended execution and
  real recipient receipt.

Evidence: [scheduled delivery trial](records/scheduled-delivery-2026-09-18.md).

## Phase 11 — Operator console and explicit handoff

- Exercise the [console contract](../specs/operator-console.md) and
  [design](../design/operator-console.md) using existing saved brief evidence.
- **Done when:** HTTP tests establish action authority, persistence, duplicate
  suppression, corruption handling and schedule controls; a small live selected
  issue trial preserves fresh input, pinned source and parent/packet provenance.
  Distinguish HTTP/HTML checks from visual browser testing and assistant review
  from maintainer acceptance.

Evidence: [operator console trial](records/operator-console-2026-09-18.md).

## Phase 12 — Shared bug and feature proposals

- Exercise the [proposal contract](../specs/change-proposal.md) in the
  [change workflow](../design/investigation-to-pr.md), using frozen real packets
  and clearly marked operator-authored fixtures.
- **Done when:** bugs and features share the proposal worker; ambiguous/mixed
  requests expose blocking questions; measurable criteria map to checks;
  relevance weaknesses and all attempts are recorded separately from runtime
  validity. No execution or maintainer acceptance is inferred.

Evidence: [proposal trial](records/change-proposal-2026-09-18.md).

## Phase 13 — Isolated fixtures, candidate integrity and review

- Exercise the [fixture contract](../specs/fixture-execution.md) and
  [design](../design/fixture-execution.md) on an owned bug and feature.
- **Done when:** actual isolation checks establish the recorded boundary, baseline
  errors remain distinct, the exact diff reconstructs each verified candidate,
  and separate model review cannot override failed checks. Preserve all live
  attempts and distinguish scripted, runtime, model and assistant review evidence.

Evidence: [fixture and patch trial](records/fixture-patches-2026-09-19.md).

## Phase 14 — Approved draft publication

- Exercise the [publisher](../design/draft-publication.md) and [contract](../specs/draft-publication.md).
- **Done when:** exact approved bug/feature bundles become draft PRs in an owned repository; fault tests distinguish unknown effects, stale authority and conflicts without duplicate creation. Human acceptance remains separate.

Implemented. Evidence: [publication trial](records/draft-publication-2026-09-19.md).

## Phase 15 — Accepted owned-project proposal

Exercise the [project profile](../design/owned-project-changes.md) and [contract](../specs/owned-project-changes.md) on publication-status filtering.

**Done when:** the real baseline preserves current behavior while recording new-feature gaps, an accepted model proposal yields a scoped candidate satisfying every mapped check, separate review has no blocking findings, and the exact tested commit becomes an owned draft. Record live failures separately from scripted boundary checks and independent human acceptance. The local workflow and published draft retain the complete trial provenance.

Preflight evidence: [owned-project qualification](records/owned-project-preflight-2026-09-19.md). Final feature evidence remains a separate live trial.

## Phase 16 — Go project trial

- Reuse the [owned-project design](../design/owned-project-changes.md) and
  [Go profile contract](../specs/owned-project-changes.md#go-profile-clippy-bubble-color-v1)
  under [ADR-0018](../adr/0018-separate-project-policy-from-language-verification.md).
- Prove Go compilation, original tests, host acceptance checks, separate review
  and exact draft publication in `bketelsen/clippy`; retain TypeScript compatibility.
- **Done when:** one live Terra candidate passes the Go profile and becomes a draft
  PR through the existing shared publisher, with language-specific receipts and
  original assets/tests unchanged. No merge or broad Go accuracy claim.

Completed. Evidence: [Clippy Go trial](records/clippy-go-trial-2026-09-19.md).

## Phase 17 — Reusable repository profiles

- Separate host repository policy, task evidence and frozen checks under
  [ADR-0019](../adr/0019-bind-repository-policy-separately-from-task-evidence.md),
  the [profile contract](../specs/repository-profiles.md) and
  [project design](../design/owned-project-changes.md).
- Reuse Go provisioning, execution, agents and publication for a second Clippy task.
- **Done when:** a task supplied through reviewed artifacts reaches an exact draft
  PR with committed regression tests, without adding task-specific orchestration
  code; stale policy/environment/checks and weakened original tests are rejected.

Completed. Evidence: [repository profile trial](records/repository-profiles-2026-09-19.md).

## Phase 18 — Reusable TypeScript tasks

- Qualify the [TypeScript adapter](../specs/repository-profiles.md#typescript-adapter)
  under [ADR-0020](../adr/0020-qualify-typescript-tasks-through-the-shared-profile-contract.md)
  and the [shared project design](../design/owned-project-changes.md).
- Exercise a bounded delivery-schedule preview task with committed regression tests,
  fixed typechecking, explicit original test-file coverage and frozen host checks.
- **Done when:** an exact draft uses the same task acceptance/worker/publication
  contracts as Go, all declared checks pass, historical records still validate,
  and mismatched adapters or weakened check coverage fail before model work.

Completed. Evidence: [reusable TypeScript trial](records/typescript-profiles-2026-09-19.md).

## Phase 19 — Portable package qualification

- Qualify [workspace boundaries and hosts](../specs/workspace-packages.md) under
  [ADR-0022](../adr/0022-package-capabilities-with-thin-host-applications.md) and
  the [package design](../design/packages-and-recipes.md).
- **Done when:** the compiled CLI, scheduled worker and MCP host work from a fresh
  production dependency install outside the source checkout; authority and lifecycle
  checks pass alongside the previously qualified execution adapters.
Completed. Evidence: [portable package qualification](records/workspace-packages-2026-09-19.md).

## Phase 20 — Read-only TrueNAS first contact

- Qualify the [TrueNAS source contract](../specs/truenas-evidence.md) under
  [ADR-0023](../adr/0023-collect-read-only-truenas-evidence-through-existing-mcp.md).
- **Done when:** one authorized live NAS observation has complete/partial coverage
  accurately represented, forced read-only mode is verified before collection, and
  simulated failures cannot expose credentials or invoke unexpected tools.
Completed. Evidence: [first-contact qualification](records/truenas-first-contact-2026-09-19.md).

## Phase 21 — SSH container inventory qualification

- Exercise the [SSH inventory contract](../specs/container-inventory.md) against the
  two authorized hosts under [ADR-0024](../adr/0024-collect-container-inventory-over-bounded-ssh.md).
- **Done when:** fixed read-only queries produce accurate scoped observations and
  explicit unavailable results; no shell substitution or missing-data zeroing is admitted.
Completed. Evidence: [SSH inventory qualification](records/container-inventory-2026-09-19.md).

## Phase 22 — k3s and homelab brief qualification

- Qualify the [cluster and brief contract](../specs/homelab-brief.md) under
  [ADR-0025](../adr/0025-compose-k3s-and-gitops-observations.md).
- **Done when:** fixed reads produce bounded cluster counts, failed or missing
  coverage is distinct from zero, and compiled offline composition preserves
  independent health/sync, scope, age and source provenance across all source kinds.
Completed. Evidence: [k3s and brief qualification](records/homelab-brief-2026-09-19.md).

## Later / ideas

Model-comparison infrastructure, new local-provider batches, broader source
corpora, and broader orchestrator qualification are deferred until the current
boundary is useful enough to justify them.

## Open questions

The v3 categories and compatibility decision are recorded in
[ADR-0005](../adr/0005-test-relevance-and-portable-agent-discovery.md). Independent
acceptance and the reliability of the unfinished-search judgment remain unmeasured.

## References

- Rationale: [ADR-0003](../adr/0003-adopt-agentic-template-retroactively.md),
  [ADR-0004](../adr/0004-compose-bounded-maintenance-agents.md).
- Context: [validation](../design/validation.md), [agents](../design/agents.md),
  [composable agents](../design/composable-agents.md).
- Contracts: [readiness](../specs/bug-readiness.md),
  [batch evaluation](../specs/batch-evaluation.md), [inbox](../specs/inbox.md),
  [location](../specs/code-location.md), [packet](../specs/investigation-packet.md).
