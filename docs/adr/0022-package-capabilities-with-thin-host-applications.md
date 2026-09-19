# 0022 — Package capabilities with thin host applications

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

Repository briefs already compose three agents, bounded collection, arithmetic,
and rendering. Source imports also pull unrelated workflows into this recipe.
The same ingredients need to serve command-line, scheduled and agent callers.
Homelab composition is a future consumer, not an expansion of OSS agent authority.

## Decision

Use private npm workspaces with coordinated versions. Extract portable runtime
primitives, subscription providers, repository analysis capabilities, the brief
recipe, scheduled delivery, and a bounded MCP adapter. Thin applications select
transport and configuration. Compile JavaScript for deployment; TypeScript source
imports remain a development option. Retain compatibility forwarding modules.

Packages may depend only on declared package exports and external dependencies;
they cannot import applications or the legacy root source tree. Keep the three
related analysis agents together until independent release needs justify splitting.
Use a stdio MCP host with bounded asynchronous jobs and saved inspection, without
adding a service per agent or a distributed workflow engine.

## Consequences

Recipes are callable from deterministic or agent orchestrators. A release includes
compiled workspaces, the dependency lock, and a hash inventory. Moving code changes
current execution identity; historical records are never rewritten. Legacy source
remains until another concrete extraction is warranted. Compatibility shims carry
maintenance cost and do not constitute a second implementation.

## Alternatives considered

- **One service per agent:** adds deployment and coordination before a workload needs it.
- **Move every source file now:** expands risk around sandbox assets and pinned trials.
- **Source-only workspaces:** do not prove that deployed applications are independent.

## References

- Builds on: [ADR-0010](0010-compose-a-repository-brief-from-bounded-evidence.md),
  [ADR-0011](0011-separate-scheduled-analysis-from-mail-delivery.md).
- Shapes: [packages and recipes](../design/packages-and-recipes.md),
  [package contract](../specs/workspace-packages.md),
  [roadmap phase 21](../plans/roadmap.md#phase-21--reusable-packages-and-thin-applications).
