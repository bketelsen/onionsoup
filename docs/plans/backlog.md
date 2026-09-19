# Plan: Twelve- and twenty-factor follow-through

Prioritized on 2026-09-18 after revisiting the original
[12-Factor Agents source](https://github.com/humanlayer/12-factor-agents/tree/d20c728368bf9c189d6d7aab704744decb6ec0cc)
and [20-factor](https://github.com/trentas/20-factor/tree/6dc491097d016c9871c32bd214431f0079673533).
The latter extends cloud-native app principles; its full checklist is not an
Onionsoup implementation mandate. This backlog complements the [roadmap](roadmap.md).

## Phase 1 — Finish explicit test relevance (implemented)

- Add direct/adjacent test evidence and completed/unfinished bounded search to
  [code-location](../specs/code-location.md), following
  [agent design](../design/agents.md) and [validation](../design/validation.md).
- Preserve historical results and publish a small Terra-only development trial.
- **Done when:** both consumers display the distinctions, compatibility and
  consistency checks pass, and live results report grounding and relevance
  separately, including failures and uncertainty.

## Phase 2 — Capability manifests and workflow events (implemented)

- Publish the two agents' capabilities and schemas; expose portable event exports
  following [composition](../design/composable-agents.md) and the
  [discovery contract](../specs/agent-discovery.md).
- **Done when:** a consumer can discover each agent's interface/effects/bounds and
  inspect a packet or agent run through common events without model calls, inbox
  state, raw prompts, or inferred success.

Phases 1–2 implementation and the trial limitations are recorded in the
[status report](records/relevance-and-discovery-2026-09-18.md). Eight new authoring
skills make the twenty-factor recommendations reusable; see
[skill routing](../../AGENTS.md#skills-follow-these-for-common-tasks).

## Phase 3 — Prove external composition (implemented)

- Implemented: Codex calls bug-readiness through the [local MCP adapter](../specs/mcp-adapter.md), following
  [composition design](../design/composable-agents.md) and
  [discovery contracts](../specs/agent-discovery.md).
- **Done when:** the same focused agent produces a traceable result through that
  consumer with existing contracts and authority unchanged. Demonstrated in the
  [external-consumer proof](records/external-composition-2026-09-18.md), including
  the first approval-configuration failure and the successful follow-up.

## Phase 4 — Bounded multi-issue recipe

- Implemented a sequential [readiness workflow](../specs/readiness-workflow.md)
  through [MCP](../specs/mcp-adapter.md), following
  [composition design](../design/composable-agents.md).
- Share one invocation allowance across single calls and workflows; preserve
  failed, unfinished, cancelled, and budget-exhausted items and common events.
- **Done when:** a three-issue external consumer proof with capacity for two
  preserves two completed runs and an explicit unattempted third issue, and
  failure/cancellation/persistence tests show no extra admission or false success.
  Demonstrated in the [workflow report](records/multi-issue-workflow-2026-09-18.md).

## Phase 5 — Two-agent handoff under shared admission

- Implemented: use a saved ready assessment and operator-pinned source to invoke code-location
  through the [location handoff](../specs/location-handoff.md), following
  [composition design](../design/composable-agents.md).
- Preserve exact parent/source identity, historical reused usage, independent agent
  boundaries, and explicit exhausted/failed/unfinished outcomes.
- **Done when:** an external consumer completes readiness then location with a
  two-invocation allowance, inspects correlated results, and tests prove that source
  or parent failures and exhausted capacity cannot bypass the boundaries. Demonstrated
  in the [two-agent proof](records/two-agent-handoff-2026-09-18.md).

## Phase 6 — On-demand maintenance briefing

- Implemented the [briefing command](../specs/maintenance-briefing.md), following
  [composition design](../design/composable-agents.md) and
  [ADR-0009](../adr/0009-produce-a-bounded-maintenance-briefing.md).
- Capture up to five issue snapshots, pin source, assess readiness and locate the
  first two ready reports under one seven-invocation allowance. Produce Markdown,
  private evidence and a common trace, with failures and capacity skips visible.
- **Done when:** one command produces a useful report from live Terra runs,
  citations match pinned source, failed/cancelled/storage boundaries prevent extra
  work, and model-free rendering preserves exact saved outcomes.

Demonstrated in the [briefing proof](records/maintenance-briefing-2026-09-18.md).

## Phase 7 — Repository brief

- Implemented the [repository brief](../specs/repository-brief.md), following
  [packages and recipes](../design/packages-and-recipes.md) and
  [ADR-0010](../adr/0010-compose-a-repository-brief-from-bounded-evidence.md).
- Collect timestamped issue/PR/CI evidence, calculate metrics and contributor
  history, summarize separate issue/PR themes, interpret health, and suggest up to
  N actions under four shared admissions. Produce local Markdown/HTML/JSON.
- **Done when:** one real repository trial displays trustworthy counts and sampled
  coverage, validated theme memberships and evidence references, bounded proposals,
  an inspectable trace, and model-free rendering; failure boundaries pass tests.

Demonstrated in the [repository brief trial](records/repository-brief-2026-09-18.md),
including the initial date-query defect and corrected follow-up.

## Phase 8 — Scheduled delivery

- Follow [adapter boundaries](../design/packages-and-recipes.md#future-trigger-and-delivery-adapters)
  around the existing [repository brief](../specs/repository-brief.md).
- **Done when:** an operator-configured schedule invokes the recipe and delivers
  its saved artifact to an authorized recipient, with durable delivery identity,
  duplicate prevention and explicit ambiguous-send handling. Retrying delivery
  must not repeat analysis.

Implemented in the [delivery contract](../specs/scheduled-delivery.md), following
[ADR-0011](../adr/0011-separate-scheduled-analysis-from-mail-delivery.md). The
[local capture trial](records/scheduled-delivery-2026-09-18.md) proves the adapter
and failure boundaries. A daily 08:00 America/New_York capture schedule is configured
locally; real SMTP forwarding and recipient receipt remain unqualified.

## Phase 9 — Operator console

- Implement the [local operator contract](../specs/operator-console.md), following
  [console design](../design/operator-console.md) and
  [ADR-0012](../adr/0012-operate-saved-workflows-through-a-local-console.md).
- **Done when:** a loopback inbox displays saved briefs and operational history,
  admits explicit run/pause/retry controls with durable identities, and hands a
  selected saved issue to fresh readiness and eligible pinned source location.
  Duplicate requests, stale authority and interrupted work cannot silently replay.

Evidence: [operator console trial](records/operator-console-2026-09-18.md).

<!-- Preserve the anchor referenced by immutable ADR-0013. -->
<a id="phase-10--change-proposals-planned"></a>

## Phase 10 — Change proposals

- Start the [investigation-to-PR plan](investigation-to-pr.md) with a read-only
  shared proposal agent for bugs and features, following the [boundary exploration](../design/investigation-to-pr.md).
- **Done when:** frozen bug packets and feature requirements/context briefs produce
  grounded change scope, measurable acceptance criteria, evidence-linked rationale
  and explicit missing information,
  giving a maintainer a concrete decision before edits or test execution.
- Preserve current bug-only location. Define a feature preparation handoff, then
  reuse downstream workers with bug regression or feature acceptance/compatibility
  obligations, following [ADR-0013](../adr/0013-converge-bugs-and-features-on-a-shared-change-proposal.md).
- Sandbox execution, patches, independent review and explicit draft publication are
  later separately gated phases. Current OSS agents retain their read-only boundary.

Implemented: [proposal contract](../specs/change-proposal.md), under
[ADR-0014](../adr/0014-draft-read-only-proposals-from-frozen-evidence.md).
Evidence: [read-only proposal trial](records/change-proposal-2026-09-18.md).

## Phase 11 — Isolated fixture verification

- Implement [owned fixture execution](../specs/fixture-execution.md) under
  [ADR-0015](../adr/0015-isolate-fixture-verification-and-scoped-patches.md), following
  the [execution design](../design/fixture-execution.md).
- **Done when:** an actual bug assertion fails on the base, feature absence is
  distinct, adjacent behavior passes, and isolation/resource/failure checks provide
  receipts without target credentials, network or writable host mounts.
- Implemented. Evidence: [fixture trial](records/fixture-patches-2026-09-19.md).

## Phase 12 — Scoped fixture patches and separate review

- Reuse one patch worker and independent-context review for the bug and feature,
  through the [same fixture contract](../specs/fixture-execution.md) and
  [design](../design/fixture-execution.md).
- **Done when:** allowed file edits reconstruct from an exact exported diff, satisfy
  the accepted criteria under the same isolated checks, and survive separate
  review; failures/advisories and finite-coverage limits remain visible.
- Implemented. Evidence: [fixture trial](records/fixture-patches-2026-09-19.md).
  No automatic revisions. Publication is a separate P13 authority; real OSS repair remains deferred.

## Phase 13 — Owned-fixture draft publication

Implement the [publication design](../design/draft-publication.md) and [contract](../specs/draft-publication.md), completing [change-workflow Phase 4](investigation-to-pr.md#phase-4--explicit-draft-publication).

**Done when:** approved exact bundles produce one bug and one feature draft in an owned repository, with tested ambiguity, stale-state and concurrency handling.

Implemented. Evidence: [publication trial](records/draft-publication-2026-09-19.md).

## Later / ideas

| Item | Trigger / acceptance evidence |
| --- | --- |
| Feature source selection | The [P10 trial](records/change-proposal-2026-09-18.md) shows broad literals finding unrelated files. Prove explicit path selection or bounded follow-up reads improve relevant context before adding a feature-location agent. |
| Smaller model context separate from full history (12F 3) | Compare evidence-preserving context assembly on frozen failures before adoption. |
| Deterministic repository-map prefetch (12F appendix) | Small pinned map reduces discovery work without hiding decisive evidence or consuming the source budget unaccountably. |
| Repeated-error/no-progress detection (12F 9) | Stop repeated equivalent failures with a useful reason; prove it does not stop recoverable cases early. |
| Broader workflow budgets (20F 18/20) | Phase 4 implements process-local invocation admission. Add durable or cross-agent quotas only for a concrete workflow; keep unknown subscription cost unknown. |
| Complete execution manifests (20F 5/16) | Link code, prompts, schemas, provider configuration, dataset/evaluator versions, and results; record limits of provider model pinning. |
| Explicit delegated authority (20F 8) | Before write-capable agents, enforce invocation permissions as a subset of caller authorization and agent capability. |
| Durable waits and recovery (12F 5–8; 20F 13) | Add only for a real wait or meaningful partial effects; test crashes, ambiguous outcomes, version changes, and reconciliation. |
| Automated relevance review (20F 6) | Version rubric and judge; separate model review from independent acceptance and calibrate against available human anchors. |
| Shared repository knowledge (20F 19) | Start with explicit scoped facts, source provenance and revision, freshness and deletion rules; keep judgments distinct from facts. |

Defer universal coordinators, registry services, mandatory gateways, vector memory,
and semantic reuse of issue judgments. Similar text is insufficient to reuse an
assessment or pinned source citation. Model comparison and local-provider batches
remain deferred; new development evaluations use Terra only.

## Open questions

- Which next bounded job provides evidence for another domain-specific team?
- When does useful repeated work justify prefetch or context reconstruction?
- Which workflow first requires durable approval or write-effect reconciliation?

## References

- Rationale: [ADR-0005](../adr/0005-test-relevance-and-portable-agent-discovery.md).
- Implements: [agents](../design/agents.md), [composition](../design/composable-agents.md),
  [validation](../design/validation.md), [location](../specs/code-location.md),
  [discovery](../specs/agent-discovery.md).
- Evidence: [evaluation plan](evaluations.md).
