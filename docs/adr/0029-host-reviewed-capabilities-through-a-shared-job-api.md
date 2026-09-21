# 0029 — Host reviewed capabilities through a shared job API

- **Status:** Accepted
- **Date:** 2026-09-21

## Context

Chat and scheduled briefs need to invoke existing capabilities without each owning
a separate execution host. Sleeper Service demonstrates useful separation between
agent execution and its consumers, but replacing AgentLayer or task contracts is
unnecessary. The current local MCP hosts remain useful standalone adapters.

## Decision

Add a local HTTP job host with a fixed, operator-configured registry. Reuse the
existing homelab collectors/triage/composition and repository-brief recipe. Keep
the generic admission, persistence, identity, cancellation and discovery package
independent of domain code. Bearer credentials identify configured invokers with
explicit capability grants; no network API edits configuration or authority.

Persist admissions and idempotency identities before execution. Serialize work in
one bounded host and preserve interrupted jobs after restart without replay. Chat
and the existing scheduled-delivery worker become optional clients; SMTP remains
outside this host. Keep deployment local until a concrete remote consumer warrants
TLS and a reviewed network authorization design.

## Consequences

Both consumers share inspection, job identity, events and persistent quotas. Task
contracts remain authoritative beneath the service. This adds a service process,
private state and invoke credentials. It does not provide exactly-once external
effects, automatic recovery, dynamic code enrollment, tenant administration or
automatic learning. Existing standalone commands remain usable.

## Alternatives considered

- Replace the runtime with Sleeper Service: would require migrating subscription
  providers and domain contracts before demonstrating value from shared hosting.
- Generalize all historical agents immediately: adds migration risk without a
  current consumer for every capability.
- Add a database and distributed queue: defer until one local host proves useful.

## References

- Shapes: [composition design](../design/packages-and-recipes.md),
  [job host contract](../specs/job-host.md), [roadmap](../plans/roadmap.md).
- Builds on: [ADR-0022](0022-package-capabilities-with-thin-host-applications.md),
  [ADR-0028](0028-separate-chat-sessions-from-domain-capabilities.md).
- Inspiration: [Sleeper Service at daaae1b](https://github.com/willjohnson/sleeper-service/tree/daaae1b86df378eee8140fbe9b662ac7e2d86170).
