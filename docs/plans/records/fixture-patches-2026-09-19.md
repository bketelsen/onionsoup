# Evaluation record: Isolated fixture runner and scoped patches — 2026-09-19

Historical evidence appendix to [the evaluation plan](../evaluations.md).
This records backlog P11/P12 and change-workflow phases 2–3. Evidence combines
scripted software tests, actual rootless-container checks, live Terra patch/review
runs, and assistant inspection. There was no independent human acceptance.

## Method and boundaries

The operator explicitly authorized an owned fixture runner followed by a patch
agent. The fixture is a dependency-free task library with a known boolean-count
bug and a requested JSON export. Host-authored accepted scopes reuse the shared
proposal result shape; no real project's P10 proposal was automatically accepted.
No get-bb/bb code, tests, branches or GitHub objects were changed.

Execution used rootless Podman 5.4.2, cgroup v2, local Debian image
`sha256:c038a8ef24ab88bc8edacfc93704c9bf301647b9253a59077f6f5342f39727ae`,
and Node v24.19.0 with binary SHA-256
`bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12`.
The attempted pull of a public Node image was rejected by the host image policy;
that policy was not changed. The already available local image passed a bounded
Node startup smoke check. No dependencies were installed in fixture execution.

The base content hash was identical across trials:
`04201213370ff428762a2cb4a759c35f519856c4090759e4ec3f2c175648c176`.
Each private Git fixture has its own recorded commit; differing commit timestamps
do not indicate different library contents. The corrected bug base is
`64fcb41a596307436b1404d749446dfc37e4423b`; corrected feature base is
`451ec9248ff202b6026869e032f811fab438dbb2`.

Both agents used Copilot / `gpt-5.6-terra`, prompts `scoped-patch-v1` and
`change-review-v1`, a shared two-invocation allowance, three model steps per child
and no automatic candidate revision. The reviewer received scope, before/after
files, exact diff and receipts, never the patch conversation. Terra is a provider
alias; an immutable model revision and byte-identical repeat behavior are unknown.

Expected outcomes before execution: the bug baseline fails exact-boolean assertions
while list behavior passes; feature baseline records missing export rather than a
bug, while existing behavior passes. The bug candidate must alter only its count
semantics. The feature must add ordered name-only JSON and documentation while
preserving the separate known count defect. Candidate checks cannot be weakened
by the patch worker. The host compares returned values outside the sandbox.

## Results and evidence

All attempts were retained under ignored `runs/fixture-trials/p11-p12-2026-09-19/`.
The two early live candidates passed function checks but had invalid exported
diffs; they are blocked attempts, not successful candidates.

| Attempt | Workflow UUID | Outcome |
| --- | --- | --- |
| Standalone bug baseline | `82a6b0a4-d545-42eb-884f-6063e4558428` | Expected assertion failures; adjacent behavior passed; zero model calls |
| Initial bug candidate | `8e33a7b5-7367-4b1c-97cb-1dd3e7dff274` | Review blocked inconsistent diff |
| Initial feature candidate | `26058246-78a8-4150-888b-89fc9ac63395` | Review blocked inconsistent diff |
| Corrected bug candidate | `53bc1ea5-2ba5-4e7a-a153-57f6d0d98e48` | All five checks passed; no blocking review findings |
| Corrected feature candidate | `076b5aa1-0d9f-4463-a075-b3bc6ed4b814` | All six checks passed; no blocking findings, one documentation advisory |

The host cloned without checkout and initially left the index empty. Git therefore
exported file deletions despite the newly written candidate contents. Both separate
reviews caught this contradiction and blocked the workflow even with passing checks.
The host was corrected to initialize the index, then independently apply the exact
exported patch to another saved-base copy and compare the reconstructed content.
A regression test applies both patch variants independently and verifies all files.
Earlier blocked records retain their original mismatched evidence.

The successful bug diff changes `task.done` to `task.done === true`; no documentation
or unrelated function changes. Its applied candidate content hash is
`2843f4c2034bc77f7aec3cc1b2bdd33ba5e0399c8914f320ccbb563644bf6e6c`.
The feature adds `exportTasks` using name-only mapping and JSON serialization,
plus a documented usage example. Count/list behavior remains unchanged; candidate
content hash is `18a535b2071cfe6a3442edaf2d1aff105f56d3b87c2e7c91d285c3707fa03e7a`.
Its reviewer flagged the retained sentence about the *base* lacking JSON export as
potentially confusing in candidate documentation. That advisory remains visible;
the candidate was not silently edited after verification.

Eight live agent invocations reported 18,987 input and 2,985 output tokens. No calls
were made for deterministic baseline/probe execution. Actual billed cost and quota
consumption are unknown. Repeat trials used fresh directories and retained earlier
results rather than overwriting or automatically retrying until green.

Actual isolation qualification checked:

- UID 65534, zero effective capabilities, no-new-privileges and seccomp filtering.
- Read-only source, harness and root; no host credential canary, inherited secret
  environment or container-engine sockets.
- Failed external network connection, an enforced 8 MiB temporary filesystem,
  and observed memory/process/CPU cgroup controls (256 MiB, 32, one CPU).
- Correct classification of syntax/import failure, timeout, excessive output,
  memory OOM, cancellation and malformed/forged pass output; named containers removed.
- A failed execution-intent checkpoint prevented process launch.

The host retained actual invocation observations separately from model context.
Final requalification reran both accepted bases/candidates without new model calls,
with exact command/environment and runner-definition hashes recorded in sidecars.
The OOM probe also exposed an empty runtime-created `oom` marker in the invoking
working directory. Container launches now set their host working directory to the
private verification directory; a regression check prevents that marker leaking
into the repository root. Earlier development receipts lack those optional fields and remain readable as such.
The implementation has pinned inputs and versioned prompts; it is not a complete
immutable release/model manifest or a statistical accuracy qualification.

Software tests cover denied file/path/command substitution, stale hashes, duplicate
edits, criterion/receipt binding, invalid review clearance, storage failure,
provider failure, cancellation, no replay, actual diff reconstruction, event privacy,
and read-only console routes. `npm run verify` passed docs, generated capability checks, TypeScript and 169
tests with real sandbox qualification enabled (zero skips). The live console exposes all five workflow attempts; HTTP/HTML
checks are not visual browser qualification.

## Limitations and next step

This proves the bounded workflow on two tiny owned tasks. It does not qualify
arbitrary repositories, dependency installers, adversarial multi-tenant execution,
platform-dependent projects or general autonomous repair. Containers share a host
kernel; finite tests and separate-context model review can both miss defects.
The candidate process can fabricate return values or overfit known behavior; host
assertions, randomized names and separate review do not prove honesty for all inputs.
Documentation's deterministic check is intentionally weak and depends on review.

Readiness, location and P10 proposal capabilities retain their original boundaries.
There is no automatic revision loop, general execution-policy editor, browser
execution action, remote branch push, PR creation or merge in this fixture workflow.
An interrupted workflow requires inspection and explicit cleanup/restart; it cannot
silently resume. Publication remains the next separately authorized boundary, or
first broaden fixture quality cases and source/context selection before real OSS work.

## References

- Plan phase: [evaluation Phase 13](../evaluations.md#phase-13--isolated-fixtures-candidate-integrity-and-review), [change workflow phases 2–3](../investigation-to-pr.md).
- Context: [fixture design](../../design/fixture-execution.md), [validation](../../design/validation.md).
- Contract: [fixture execution](../../specs/fixture-execution.md).
- Rationale: [ADR-0015](../../adr/0015-isolate-fixture-verification-and-scoped-patches.md).
- Runtime reference: [Podman run documentation](https://docs.podman.io/en/v5.6.2/markdown/podman-run.1.html); the tested host used 5.4.2 as recorded above.
