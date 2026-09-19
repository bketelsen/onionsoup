# 0019 — Bind repository policy separately from task evidence

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

The two live project trials proved shared workers across TypeScript and Go, but
repository policy, feature prose, paths and acceptance checks remained in a code
registry. The operator authorized reusable repository profiles and a second Clippy
task without new task-specific orchestration code.

## Decision

Add an operator-supplied repository profile, a separate task artifact and a frozen
host verification plan. Initially qualify the reusable `go-module-v1` adapter;
retain historical Go and TypeScript profiles without reinterpreting their artifacts.
The profile owns identity, toolchain policy, standard checks and path boundaries.
The task owns the request, base, narrowed paths, source excerpts and check expectations.
Host acceptance binds both artifacts, their hashes, the verification plan digest,
resolved runtime/dependency identities and the model proposal into a v2 job.

Reuse the existing proposal, patch, review, execution and publication functions.
Host-owned Go test overlays and simple file-change assertions express task checks;
models cannot choose commands or edit those checks. Existing target test files may
only be appended to, so regression tests can accompany the PR without rewriting
original tests. New task checks remain outside model context.

Repository-supplied policy is not automatically trusted. Profiles enter only through
operator-controlled local arguments. Publication remains a separately authorized
exact-bundle effect with matching repository ID and base branch; no merge is added.

## Consequences

A new Go task is data and acceptance evidence, not a new engine branch. Missing
modules, unsupported projects, source bounds, failed baselines and stale runtime or
policy bindings still fail closed. Append-only test files are a narrow initial
editing policy, not semantic proof that new tests are honest. General TypeScript
repository onboarding remains unqualified; its existing concrete profile stays usable.

## Alternatives considered

- Add another feature-specific profile: would not prove task reuse.
- Let models supply build commands: mixes semantic task judgment with execution authority.
- Automatically trust policy edited in the candidate: lets a patch redefine its checks.

## References

- Builds on [ADR-0018](0018-separate-project-policy-from-language-verification.md).
- Shapes [repository profile contract](../specs/repository-profiles.md) and
  [owned-project design](../design/owned-project-changes.md).
- Implements [roadmap Phase 19](../plans/roadmap.md#phase-19--reusable-repository-profiles).
