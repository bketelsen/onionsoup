# 0023 — Collect read-only TrueNAS evidence through the existing MCP server

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

The owner supplied a working local TrueNAS MCP implementation, credentials in its
external `.envrc`, and authorization to read one NAS with a self-signed certificate.
This provides the first homelab evidence source without extending OSS agent jobs.
The server already aggregates system, pool, disk and alert observations.

## Decision

Add a reusable TrueNAS source adapter and a thin homelab CLI. Force writes off in
both arguments and environment, verify the discovered read-only tool catalog, and
invoke only `truenas_health_report` with no arguments. Keep certificate-verification
exceptions explicit and scoped to this child process. Never copy credentials into
Onionsoup configuration, arguments, artifacts or diagnostics.

Normalize the report into bounded counts, pool flags, alert severity counts and
section coverage. Preserve unknown and failed sections separately from observed
health. Save admission before contact and a terminal result afterward. No model is
needed for this deterministic acquisition step; later agents can consume this
versioned evidence instead of broad management tools or raw NAS data.

## Consequences

The existing server remains independently maintained. Onionsoup cannot request
arbitrary tools or writes through this adapter. New upstream tools require explicit
catalog review. A snapshot is not an exhaustive health assessment or a transactional
NAS view. This first integration neither supplies repair authority nor sends NAS
data to a model provider.

## Alternatives considered

- **Reimplement the TrueNAS API client:** duplicates working transport/authentication.
- **Expose every tool directly to a new agent:** widens authority before evidence quality is established.
- **Add a model to summarize counts:** adds no necessary judgment to first contact.

## References

- Builds on: [ADR-0022](0022-package-capabilities-with-thin-host-applications.md).
- Shapes: [package design](../design/packages-and-recipes.md),
  [TrueNAS evidence contract](../specs/truenas-evidence.md),
  [roadmap phase 22](../plans/roadmap.md#phase-22--read-only-truenas-evidence).
