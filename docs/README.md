# Onionsoup documentation

Start with [packages and recipes](design/packages-and-recipes.md) for composition
and deployment, or [focused agents](design/agents.md) for the OSS workflows.
The [roadmap](plans/roadmap.md) separates implemented work from future exploration;
[evaluation evidence](plans/evaluations.md) records qualification and its limits.

Documentation follows the owner's agentic-template, recorded in
[ADR-0003](adr/0003-adopt-agentic-template-retroactively.md). Follow
[AGENTS.md](../AGENTS.md), use category templates, and run `npm run check:docs`.

## Design — how

- [Design template](design/TEMPLATE.md)
- [Focused agents and artifact handoffs](design/agents.md)
- [“Taco-bell orchestration”: reusable agents, different recipes](design/composable-agents.md)
- [Owned-fixture draft publication](design/draft-publication.md)
- [Owned fixture execution and scoped candidates](design/fixture-execution.md)
- [From bug reports and feature requests to a reviewable change](design/investigation-to-pr.md)
- [Local maintainer operator console](design/operator-console.md)
- [Accepted proposals in an owned project](design/owned-project-changes.md)
- [Agent packages, recipes, and adapters](design/packages-and-recipes.md)
- [Repository layout and instruction discovery](design/repository-layout.md)
- [Twelve factors, applied to Onionsoup](design/twelve-factors.md)
- [Validation record](design/validation.md)

## Specs — exact contracts

- [Workload triage and homelab MCP](specs/workload-triage.md)
- [Homelab conversational delegation proof](specs/homelab-delegation.md)
- [Persistent chat and homelab profile](specs/chat.md)

- [k3s observations and homelab briefs](specs/homelab-brief.md)

- [Container inventory over SSH](specs/container-inventory.md)

- [Read-only TrueNAS evidence](specs/truenas-evidence.md)

- [Spec template](specs/TEMPLATE.md)
- [Agent capability manifests and workflow event exports](specs/agent-discovery.md)
- [Frozen batch evaluation](specs/batch-evaluation.md)
- [Bug-report readiness contract, version 2](specs/bug-readiness.md)
- [Read-only change proposals, version 1](specs/change-proposal.md)
- [Code-location contract, version 3](specs/code-location.md)
- [Owned-fixture draft publication](specs/draft-publication.md)
- [Owned fixture execution and patches, version 1](specs/fixture-execution.md)
- [Read-only maintenance inbox](specs/inbox.md)
- [Portable investigation packet, version 1](specs/investigation-packet.md)
- [Saved readiness to pinned code-location handoff, version 1](specs/location-handoff.md)
- [On-demand maintenance briefing, version 1](specs/maintenance-briefing.md)
- [Local MCP adapter, version 1](specs/mcp-adapter.md)
- [Local operator console, version 1](specs/operator-console.md)
- [Accepted owned-project implementation jobs](specs/owned-project-changes.md)
- [Bounded multi-issue readiness workflow, version 1](specs/readiness-workflow.md)
- [Repository brief and focused summary capabilities, version 1](specs/repository-brief.md)
- [Repository layout and documentation checks](specs/repository-layout.md)
- [Repository profiles and accepted tasks](specs/repository-profiles.md)
- [Scheduled repository-brief delivery, version 1](specs/scheduled-delivery.md)
- [Workspace packages and repository-brief hosts](specs/workspace-packages.md)

## Plans — order of work

- [Plan template](plans/TEMPLATE.md)
- [Twelve- and twenty-factor follow-through](plans/backlog.md)
- [Evaluation evidence and next qualification](plans/evaluations.md)
- [Bug and feature evidence to a draft PR](plans/investigation-to-pr.md)
- [Onionsoup roadmap](plans/roadmap.md)
- [Retroactive template adoption](plans/template-adoption.md)

## Decisions — why

- [0026 — Triage workload findings through bounded evidence](adr/0026-triage-workload-findings-through-bounded-evidence.md)
- [0027 — Observe Workflow owners and prove model delegation](adr/0027-observe-workflow-owners-and-prove-model-delegation.md)
- [0028 — Separate chat sessions from domain capabilities](adr/0028-separate-chat-sessions-from-domain-capabilities.md)

- [0025 — Compose k3s and GitOps observations](adr/0025-compose-k3s-and-gitops-observations.md)

- [0024 — Bounded SSH container inventory](adr/0024-collect-container-inventory-over-bounded-ssh.md)

- [0023 — Read-only TrueNAS acquisition](adr/0023-collect-read-only-truenas-evidence-through-existing-mcp.md)

- [0001 — Record architecture decisions](adr/0001-record-architecture-decisions.md)
- [0002 — Agent-portable instruction surface](adr/0002-agent-portable-instruction-surface.md)
- [0003 — Adopt agentic-template without changing agent behavior](adr/0003-adopt-agentic-template-retroactively.md)
- [0004 — Compose bounded maintenance agents through versioned artifacts](adr/0004-compose-bounded-maintenance-agents.md)
- [0005 — Explicit test relevance and portable agent discovery](adr/0005-test-relevance-and-portable-agent-discovery.md)
- [0006 — Prove external composition through a local MCP adapter](adr/0006-prove-composition-through-local-mcp.md)
- [0007 — Bound a multi-issue readiness workflow with shared admission](adr/0007-bound-a-multi-issue-readiness-workflow.md)
- [0008 — Hand off saved ready assessments to pinned source location](adr/0008-handoff-ready-assessments-to-pinned-source-location.md)
- [0009 — Produce an on-demand bounded maintenance briefing](adr/0009-produce-a-bounded-maintenance-briefing.md)
- [0010 — Compose a repository brief from bounded evidence](adr/0010-compose-a-repository-brief-from-bounded-evidence.md)
- [0011 — Separate scheduled analysis from mail delivery](adr/0011-separate-scheduled-analysis-from-mail-delivery.md)
- [0012 — Operate saved workflows through a local console](adr/0012-operate-saved-workflows-through-a-local-console.md)
- [0013 — Converge bugs and features on a shared change proposal](adr/0013-converge-bugs-and-features-on-a-shared-change-proposal.md)
- [0014 — Draft read-only proposals from frozen evidence](adr/0014-draft-read-only-proposals-from-frozen-evidence.md)
- [0015 — Isolate fixture verification and scoped patches](adr/0015-isolate-fixture-verification-and-scoped-patches.md)
- [0016 — Publish only approved fixture bundles](adr/0016-publish-only-approved-fixture-bundles.md)
- [0017 — Execute one accepted owned-project proposal](adr/0017-execute-one-accepted-owned-project-proposal.md)
- [0018 — Separate project policy from language verification](adr/0018-separate-project-policy-from-language-verification.md)
- [0019 — Bind repository policy separately from task evidence](adr/0019-bind-repository-policy-separately-from-task-evidence.md)
- [0020 — Qualify TypeScript tasks through the shared profile contract](adr/0020-qualify-typescript-tasks-through-the-shared-profile-contract.md)
- [0021 — Apply test appends without model reconstruction](adr/0021-apply-test-appends-without-model-reconstruction.md)
- [0022 — Package capabilities with thin host applications](adr/0022-package-capabilities-with-thin-host-applications.md)
- [ADR template](adr/TEMPLATE.md)

## Historical evaluation evidence

- [Persistent homelab chat — 2026-09-20](plans/records/chat-2026-09-20.md)
- [Workload triage — 2026-09-19](plans/records/workload-triage-2026-09-19.md)
- [Workflow owners and model delegation — 2026-09-20](plans/records/workflow-delegation-2026-09-20.md)

- [k3s and homelab brief — 2026-09-19](plans/records/homelab-brief-2026-09-19.md)

- [SSH container inventory — 2026-09-19](plans/records/container-inventory-2026-09-19.md)

- [TrueNAS first contact — 2026-09-19](plans/records/truenas-first-contact-2026-09-19.md)

Dated reports preserve their original findings; software tests do not establish model quality.

- [Evaluation record template](plans/records/TEMPLATE.md)
- [Terra/Luna held-out issue evaluation — 2026-09-18](plans/records/bb-heldout-2026-09-18.md)
- [Real-issue pilot: get-bb/bb, 2026-09-18](plans/records/bb-pilot-2026-09-18.md)
- [Shared bug and feature proposals — 2026-09-18](plans/records/change-proposal-2026-09-18.md)
- [Clippy Go trial — 2026-09-19](plans/records/clippy-go-trial-2026-09-19.md)
- [Code-location pilot — 2026-09-18](plans/records/code-location-pilot-2026-09-18.md)
- [Search and test selection follow-up — 2026-09-18](plans/records/code-location-search-2026-09-18.md)
- [Owned-fixture draft publication — 2026-09-19](plans/records/draft-publication-2026-09-19.md)
- [Codex external composition — 2026-09-18](plans/records/external-composition-2026-09-18.md)
- [Isolated fixture runner and scoped patches — 2026-09-19](plans/records/fixture-patches-2026-09-19.md)
- [Read-only intake pilot — 2026-09-18](plans/records/inbox-pilot-2026-09-18.md)
- [Local server assessment — 2026-09-18](plans/records/local-server-evaluation-2026-09-18.md)
- [On-demand maintenance briefing — 2026-09-18](plans/records/maintenance-briefing-2026-09-18.md)
- [Bounded multi-issue workflow — 2026-09-18](plans/records/multi-issue-workflow-2026-09-18.md)
- [Operator console — 2026-09-18](plans/records/operator-console-2026-09-18.md)
- [Owned-project execution preflight — 2026-09-19](plans/records/owned-project-preflight-2026-09-19.md)
- [Portable investigation packet pilot — 2026-09-18](plans/records/packet-pilot-2026-09-18.md)
- [Status: Test relevance, discovery, events, and skills — 2026-09-18](plans/records/relevance-and-discovery-2026-09-18.md)
- [Bounded test completion and source-linked overviews — 2026-09-18](plans/records/reliability-2026-09-18.md)
- [Aggregate repository brief — 2026-09-18](plans/records/repository-brief-2026-09-18.md)
- [Reusable repository profiles — 2026-09-19](plans/records/repository-profiles-2026-09-19.md)
- [Scheduled delivery — 2026-09-18](plans/records/scheduled-delivery-2026-09-18.md)
- [Terra comparison, 2026-09-18](plans/records/terra-comparison-2026-09-18.md)
- [Following fixtures to assertions — 2026-09-18](plans/records/test-selection-2026-09-18.md)
- [Two-agent handoff — 2026-09-18](plans/records/two-agent-handoff-2026-09-18.md)
- [Reusable TypeScript tasks — 2026-09-19](plans/records/typescript-profiles-2026-09-19.md)
- [Portable workspace packages — 2026-09-19](plans/records/workspace-packages-2026-09-19.md)

## Related repository material

- [README and commands](../README.md)
- [Canonical contributor instructions](../AGENTS.md)
- [Sources and attribution](../REFERENCES.md)
- [Reusable agent skills](../.agents/skills/)
