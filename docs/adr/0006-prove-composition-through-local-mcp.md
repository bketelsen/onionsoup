# 0006 — Prove external composition through a local MCP adapter

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

The inbox and packet reuse the same focused agents, but both consumers are part
of Onionsoup. Published schemas and events alone do not demonstrate that an
external orchestrator can invoke an agent and inspect its outcome. Codex is
already available through the owner's subscription.

## Decision

Use Codex as the first external consumer, connected through an MCP stdio adapter.
Expose bug-readiness invocation and session-scoped inspection, plus discovery of
the existing agent manifests. Call the existing `triage` function unchanged.
The operator fixes provider/model, private artifact directory, and a finite
invocation allowance at launch. Default to one invocation and reject concurrent
invocations. Inspection and discovery do not initialize providers.

Return the existing assessment with run identity and common workflow events;
keep raw model state in private local artifacts. Cancellation is cooperative.
An interrupted process or unexpected exception may leave an unfinished record;
there is no automatic retry, resume, or exactly-once claim.

## Consequences

An actual consumer can prove reuse with the same contracts and authority. The MCP
SDK becomes a dependency. The adapter remains a local process with session-scoped
lookup, not a shared server or a durable workflow engine. Starting another process
resets its admission allowance. Code-location remains discoverable but is not
invocable through this adapter until a concrete source-acquisition workflow is
chosen.

## Alternatives considered

- **GitHub Actions:** useful later, but subscription credential distribution and
  remote checkout policy add unrelated work to this first integration.
- **Universal invocation gateway:** premature for one demonstrated consumer.
- **Another in-repository caller:** would not prove an external consumer.

## References

- Builds on: [ADR-0004](0004-compose-bounded-maintenance-agents.md),
  [ADR-0005](0005-test-relevance-and-portable-agent-discovery.md).
- Shapes: [composition design](../design/composable-agents.md),
  [MCP contract](../specs/mcp-adapter.md), [backlog Phase 3](../plans/backlog.md#phase-3--prove-external-composition-implemented).
