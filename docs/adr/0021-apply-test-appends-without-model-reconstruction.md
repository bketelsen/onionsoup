# 0021 — Apply test appends without model reconstruction

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

The reusable TypeScript trial stopped after the patch worker repeatedly reconstructed
an original test file incorrectly. The policy already permits only appending tests,
but complete replacement output makes the model reproduce every unrelated byte.
The host already owns those exact bytes and their accepted hash.

## Decision

Add an optional `operation` to project edit records. Omitted or `replace` retains
complete replacement semantics. `append` supplies only new text, and is admitted
only for original test paths in repository-task jobs. The host checks the existing
file hash and scope, concatenates original bytes with the supplied suffix, validates
the resulting size and preserves the original-test rule. One shared application
function drives execution and saved-record reconstruction.

Version the patch prompt; preserve validation of historical prompt-v1 runs and
replacement records. New execution acceptance freezes the changed adapter. Neither
this operation nor a passing file-change check establishes test relevance. Independent
host checks and review still decide whether a candidate can advance.

## Consequences

The worker need not emit unchanged original tests. There is no new path authority,
new-file creation, arbitrary diff parser, offset matching or automatic repair loop.
Appending code can still alter behavior, so preserving bytes is a narrow guarantee.
The extra edit operation must be rejected for historical jobs and non-test paths.

## Alternatives considered

- Repeated complete-file retries: retains the demonstrated copying failure.
- General text patches: adds offset and reconstruction complexity without evidence
  that broader edits are necessary for the current append-only policy.

## References

- Builds on: [ADR-0019](0019-bind-repository-policy-separately-from-task-evidence.md),
  [ADR-0020](0020-qualify-typescript-tasks-through-the-shared-profile-contract.md).
- Shapes: [repository profiles](../specs/repository-profiles.md),
  [owned-project design](../design/owned-project-changes.md),
  [roadmap Phase 20](../plans/roadmap.md#phase-20--reusable-typescript-tasks).
