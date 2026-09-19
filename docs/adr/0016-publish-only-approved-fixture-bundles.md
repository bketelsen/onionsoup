# 0016 — Publish only approved fixture bundles

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

The owned-fixture runner produces tested bug and feature candidates. Publication
adds remote effects and ambiguous-response recovery. The operator authorized live
draft trials only in repositories owned by `bketelsen`; `get-bb/bb` is excluded.

## Decision

Use a deterministic host publisher, separate from agents. Prepare an immutable
bundle containing destination identity, exact base/head/diff, title/body and the
validated fixture evidence. Record approval against its digest and configuration
revision before effects. A browser can select a saved bundle, never a destination,
command, path or credential. Existing explicit session authorization may be recorded
by the CLI with its provenance; it does not require another human confirmation.

Pin the GitHub repository numeric identity and base branch commit in host config.
Use a stable unique branch, refuse overwrites, persist intent before push and PR
creation, and reconcile all-state PRs by branch and exact content. An ambiguous PR
creation with no observed result remains unknown and is never automatically retried.
Use a local exclusive lock; stale locks require operator inspection. Do not claim
cross-host exactly-once behavior or transactional base locking on GitHub.

## Consequences

The same bundle supports CLI and console consumers without another model. The
first implementation supports only the two-file owned fixture, with no merge,
reviewer assignment, comment, general repository execution or autonomous revisions.
Finite evidence and model review remain distinct from human code acceptance.

## Alternatives considered

- **Give the patch agent GitHub tools:** mixes implementation and publication authority.
- **Retry every failed create:** can duplicate a PR after a lost response.
- **General publishing framework:** defer until a second real use case exists.

## References

- Builds on: [ADR-0015](0015-isolate-fixture-verification-and-scoped-patches.md), [ADR-0012](0012-operate-saved-workflows-through-a-local-console.md).
- Shapes: [design](../design/draft-publication.md), [contract](../specs/draft-publication.md).
- Implements: [Phase 4](../plans/investigation-to-pr.md#phase-4--explicit-draft-publication).
