# 0018 — Separate project policy from language verification

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

The first owned-project trial used TypeScript, npm and text-only source exports.
The operator requested a Go trial in `bketelsen/clippy`, whose renderer embeds a
PNG and font. Copying its orchestration would not demonstrate reusable agents.

## Decision

Reuse proposal, accepted-job, scoped-patch, review, commit reconstruction and draft
publication functions. Select an explicit host-owned project profile for repository,
paths, request, checks and baseline eligibility. Add `clippy-bubble-color-v1`, limited
to `main.go` and `README.md`, with offline Go compilation, unchanged original tests,
vet, formatting and host-owned color checks. Binary assets may be exported unchanged
with byte and path bounds. Go toolchain and downloaded modules are separately pinned;
only manifest provisioning has network access, never target execution.

Existing artifact versions remain readable. The additional profile is an additive
contract alternative; profile-specific validation prevents mixing repositories,
paths, toolchains, dependencies or checks. Capability versions advance. Agents keep
their existing jobs and tools. Execution and publication still require separate
recorded authority, and no merge is authorized.

## Consequences

The engine can demonstrate two languages using the same orchestration. Each new
profile still needs host-authored acceptance checks and qualification. Go requires
bounded executable scratch for compiled test binaries; this differs explicitly from
the Node profile's noexec scratch. Passing finite tests does not establish hostile-code
isolation or broad Go maintenance competence.

## Alternatives considered

- A separate Go agent pipeline: duplicates authority and recovery logic.
- Arbitrary model-selected build commands: expands execution authority unnecessarily.
- Text-only source: cannot compile Clippy's unchanged embedded resources.

## References

- Builds on [ADR-0017](0017-execute-one-accepted-owned-project-proposal.md).
- Shapes [owned-project design](../design/owned-project-changes.md) and
  [contract](../specs/owned-project-changes.md).
- Implements [roadmap](../plans/roadmap.md) and [evaluation plan](../plans/evaluations.md).
