# 0020 — Qualify TypeScript tasks through the shared profile contract

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

[ADR-0019](0019-bind-repository-policy-separately-from-task-evidence.md) separated
repository policy from tasks for Go. The earlier TypeScript profile still embeds
one publication-filter feature. A second language should use the same acceptance,
patch, review and draft-publication contracts without adopting task command strings.

## Decision

Add `node-typescript-v1` to the operator-supplied repository profile. Pin the Node
binary and version, public integrity-locked npm dependencies, fixed offline sandbox,
typechecking and an explicit list of original Node test files. Execute those files
in full with no test-name filter. Require passing, nonempty test evidence without
skips, cancellations or todos. Protect manifests, TypeScript configuration and
original test bytes. The profile declares selected-file coverage, not the full suite.

A separate frozen verification plan provides named JavaScript check exports. A
fixed host harness calls them under the existing isolated Node/tsx runtime, retains
failed checks and validates exact result coverage. Check source remains outside
worker context. No npm scripts or model-authored commands run. Ordinary file-change
checks retain their limited meaning. Task/profile/check adapter mismatches fail.

Qualify with a bounded delivery-schedule preview helper in Onionsoup, preserving
historical Go and TypeScript records and reusing the same shared workflow and
publisher. Existing user authorization permits owned draft trials; it does not
confer merge authority or independent maintainer acceptance.

## Consequences

TypeScript onboarding needs data and host acceptance checks rather than another
feature-specific runtime. The selected original suite must be sufficient for the
task and execute offline. Native builds, installation scripts, new files, arbitrary
commands, new test imports in original files, automatic repair and resume remain
outside this phase. Same-process observations and a shared kernel retain the
existing trust limitations.

## Alternatives considered

- Another hard-coded feature profile: repeats task logic inside infrastructure.
- Arbitrary npm commands: widens authority and obscures the actual verified scope.
- All repository tests by default: some require unavailable tools or services;
  explicit reviewed test-file coverage makes the limitation visible.

## References

- Builds on: [ADR-0018](0018-separate-project-policy-from-language-verification.md),
  [ADR-0019](0019-bind-repository-policy-separately-from-task-evidence.md).
- Shapes: [repository profiles](../specs/repository-profiles.md),
  [owned-project design](../design/owned-project-changes.md),
  [roadmap Phase 20](../plans/roadmap.md#phase-20--reusable-typescript-tasks).
