# 0028 — Separate chat sessions from domain capabilities

- **Status:** Accepted
- **Date:** 2026-09-20

## Context

The model-delegation proof established one bounded homelab recipe. It has a fixed
request, no follow-up state and stale baseline sources. A conversational consumer
must preserve evidence, authority and budgets across turns without becoming a
monolithic infrastructure agent.

## Decision

Package a domain-independent chat runtime, a homelab profile and a thin interactive
CLI separately. Profiles provide reviewed tools and evidence validation; the core
owns bounded model execution, session persistence, turn outcomes and locking.
Homelab tools delegate through the existing MCP host. Add only fixed source-refresh
jobs and selected-finding inspection, reusing the existing read-only collectors.

Keep provider/model/profile bindings immutable for a session. Persist reservations
before effects, retain job references across restart, and require inspection before
citing evidence in a new answer. Unknown or stale coverage stays explicit. Recovery
marks an interrupted turn; it never replays a model or read job automatically.

## Consequences

Other profiles can reuse conversation lifecycle without importing homelab code.
A profile still requires reviewed implementation; arbitrary discovered MCP tools
are not automatically installed. More checkpoints and versioned state are needed.
The CLI is the first interface; a browser can later call the same API. Crash locks
require operator recovery, as for the existing MCP host. There is no write authority.

## Alternatives considered

- **Grow the proof script:** mixes session lifecycle, transport and domain policy.
- **Generic MCP pass-through:** lets discovery accidentally become authority.
- **Persist full model transcripts:** duplicates sensitive evidence and grows context
  without improving the narrow follow-up task.

## References

- Builds on [ADR-0027](0027-observe-workflow-owners-and-prove-model-delegation.md)
  and [ADR-0022](0022-package-capabilities-with-thin-host-applications.md).
- Shapes [chat contract](../specs/chat.md), [workload/MCP contract](../specs/workload-triage.md),
  [package design](../design/packages-and-recipes.md) and
  [roadmap phase 27](../plans/roadmap.md#phase-27--persistent-chat-and-homelab-profile).
