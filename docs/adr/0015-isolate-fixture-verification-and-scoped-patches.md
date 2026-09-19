# 0015 — Isolate fixture verification and scoped patches

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

Read-only proposals cannot establish that a change works. The operator explicitly
authorized an owned fixture runner followed by a patch agent. This does not extend
the authority of readiness, location or proposal agents, or authorize OSS writes.

## Decision

Use a deterministic rootless Podman runner, restricted to a checked-in owned task
library fixture. Pin the local image ID, Node binary hash, fixture Git commit/tree,
accepted proposal and verification policy. No image pull or dependency install is
part of execution. Enforce no network, no capabilities, no new privileges, non-root
execution, read-only source/harness/runtime, bounded tmpfs, memory, CPU, processes,
wall time and output. Mount no host credentials, home, Git directory or sockets.
Fail closed on unavailable isolation, stale inputs, timeout or failed cleanup.

Compare actual function return values with host-owned assertions outside the
candidate process. Preserve original checks; absent feature exports are capability
gaps, not bug reproductions or passing checks. The fixture includes a known bug,
a small feature request and unchanged adjacent behavior.

A focused patch agent returns complete replacement text only for named allowed
files. It has no shell or filesystem tools. The host validates scope and base hashes,
materializes one candidate in a fresh local directory and verifies its exact tree.
A separate read-only change-review agent receives accepted scope, before/after
files and receipts, without the patch conversation. It cannot approve publication.
Use one shared two-invocation allowance (patch and review), with no automatic rewrite.

The accepted fixture scopes are host-authored instances of the shared proposal
contract, bound to this explicit fixture authorization. Arbitrary public proposals
cannot be promoted to execution by passing `proposal_ready`. The console exposes
saved fixture receipts and candidates read-only. PR publication remains deferred.

## Consequences

Bugs and features share patch and review contracts with different baseline checks.
The host retains assertion authority and immutable test selection. Containers share
the kernel; this is not a sandbox for hostile multi-tenant workloads or a proof of
kernel isolation. Candidate code can misreport protocol values or overfit tests;
independent context review and bounded held-out inputs reduce, not eliminate, that
risk. Current qualification applies to the tiny dependency-free fixture only.

## Alternatives considered

- **Worktree-only execution:** does not isolate untrusted code or credentials.
- **Model-owned tests and pass/fail:** lets the patch worker weaken its own evidence.
- **General repair service:** premature before a fixture proves the boundaries.

## References

- Builds on: [ADR-0014](0014-draft-read-only-proposals-from-frozen-evidence.md).
- Shapes: [fixture execution design](../design/fixture-execution.md),
  [fixture and patch contract](../specs/fixture-execution.md),
  [change workflow phases 2–3](../plans/investigation-to-pr.md).
