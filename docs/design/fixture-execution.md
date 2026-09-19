# Owned fixture execution and scoped candidates

Living document. Rationale: [ADR-0015](../adr/0015-isolate-fixture-verification-and-scoped-patches.md).
Contract: [fixture execution](../specs/fixture-execution.md).

## Overview

The operator-owned task library proves execution and patch boundaries before any
real OSS repair. Bugs and features use one runner, one scoped patch worker and one
separate review worker. Current scope is a dependency-free two-file fixture.

```mermaid
flowchart LR
    Scope[Accepted fixture proposal + base] --> Base[Isolated baseline]
    Base --> Patch[Scoped patch agent]
    Patch --> Host[Validate edits and independently apply exact diff]
    Host --> Check[Isolated candidate checks]
    Check --> Review[Separate change-review context]
    Review --> Artifact[Local evidence bundle]
```

## Design

Host-owned fixture scopes use the shared [proposal](../specs/change-proposal.md)
shape. Existing P10 proposals still record acceptance as unrecorded; this recipe
creates a separate accepted scope under the operator's explicit fixture instruction.
It never infers execution authority from a model's `proposal_ready` result.

The runner validates rootless Podman/cgroup v2 and a pinned local image/Node pair.
It copies only two fixture files, the trusted invocation harness and the pinned
binary into fresh mounts. Source and harness are read-only; the sandbox receives
only bounded invocation arguments on stdin. Host assertions compare returned values
outside the candidate process. Original assertions and criterion mappings are not
editable by the patch agent. Randomized names expose some literal overfitting;
this is not a complete adversarial test oracle.

The patch worker returns text, never filesystem or shell operations. The host
checks exact before hashes and allowed filenames, writes a fresh candidate,
exports its diff, and independently applies that diff to a second copy of the
saved base. The reconstructed content hash must match the candidate before checks.
The reviewer sees accepted scope, before/after files, diff and receipts, without
patch messages or self-evaluation. Successful verification and no blocking review
findings are separate gates; publication remains unauthorized.

A shared allowance permits one patch and one review. Initial state, execution
intents and reservations are saved before effects. Failed persistence stops work;
crashes leave unfinished evidence and named containers for deliberate inspection.
There is no automatic replay or revision loop. Independent baseline and patch runs
use fresh directories and preserve earlier unsuccessful trials.

## Operational notes

Use an existing trusted local image. The runner never downloads images or installs
dependencies. The development host rejected a remote Node image under its existing
image policy; the implementation used its existing Debian image and pinned local
Node binary without changing that policy.

Runtime pins identify image bytes, Node bytes and Podman version, not an immutable
model deployment. New execution receipts also hash the runner/check definitions and
retain the exact command/environment sidecar. Source commits, accepted criteria,
check sets, actual return observations, before/after files and diffs remain local.
No credential values enter the sandbox or published trial report. The kernel is
shared; a container is not a VM or a guarantee against kernel exploits.

The [console](operator-console.md) displays configured `fixtureRoots` read-only.
Only the CLI launches these trials. Resource qualification requires the local
runtime configuration; credential-free unit tests use an explicitly scripted runner.
The [trial record](../plans/records/fixture-patches-2026-09-19.md) distinguishes them.

## References

- Rationale: [ADR-0015](../adr/0015-isolate-fixture-verification-and-scoped-patches.md).
- Contract: [fixture execution](../specs/fixture-execution.md), [discovery/events](../specs/agent-discovery.md).
- Built in: [backlog P11/P12](../plans/backlog.md#phase-11--isolated-fixture-verification), [change workflow phases 2–3](../plans/investigation-to-pr.md).
- Broader context: [investigation-to-PR design](investigation-to-pr.md).
