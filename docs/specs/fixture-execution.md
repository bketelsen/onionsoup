# Spec: Owned fixture execution and patches, version 1

This contract governs the deterministic runner and two focused agents under
[ADR-0015](../adr/0015-isolate-fixture-verification-and-scoped-patches.md).
[Design](../design/fixture-execution.md); [strict schemas](../../src/fixture-runner/contracts.ts).

## Interface

```sh
# Pin an already available trusted image and the Node binary running this CLI.
npm run fixture -- pin --image docker.io/library/debian:trixie --output .local/fixture/runtime.json
npm run fixture -- baseline bug --runtime .local/fixture/runtime.json --output runs/NEW_BASELINE --provider copilot
npm run fixture -- patch bug --runtime .local/fixture/runtime.json --output runs/NEW_BUG --provider copilot
npm run fixture -- patch feature --runtime .local/fixture/runtime.json --output runs/NEW_FEATURE --provider copilot
npm run fixture -- render runs/NEW_FEATURE
```

Only `bug` and `feature` scopes are supported. The recipe creates a fresh owned Git
fixture from [the checked-in files](../../examples/fixture-project/README.md).
It accepts no target repository, arbitrary command, source path or model-selected
runtime. Copilot/Codex and Terra are explicit at the application edge. Pinning never
pulls an image. Every workflow requires a new output directory; render is read-only
apart from derived report/event files.

Callable agents: `proposeScopedPatch(input, options)` and `reviewChange(input, options)`
in [agents.ts](../../src/fixture-runner/agents.ts). Caller supplies the AI SDK model,
provider and modelId; optional signal/checkpoint. The agents return data only.
Host recipe: `runFixture(case, options)`. `verifyFiles` is the lower-level trusted
host adapter; it is not an agent tool or exposed HTTP execution endpoint.

| Artifact | Meaning |
| --- | --- |
| Runtime v1 | Local OCI image ID, canonical Node path/hash, Podman version; revalidated before execution |
| Accepted scope v1 | Scope UUID, fixture case, base Git commit/content hash, shared proposal/hash, allowed files, explicit fixture authorization and policy version |
| Patch result v1 | `candidate` with bounded complete file replacements and exact before hashes, or `needs_information` with questions and no edits |
| Verification receipt v1 | Scope/tree/runtime/policy/harness/check-set hashes, phase, outcome, individual criterion checks, timing, exit/OOM/output metadata and cleanup |
| Review result v1 | `no_blocking_findings`, `changes_requested`, or `insufficient_evidence`; findings cite after-file lines and criterion IDs; limitations required |
| Workflow v1 | Frozen scope, runtime, before/after, diff/hash/applied-tree proof, execution receipts, child runs, reservations and outcome; publication `not_authorized` |

## Rules

- The authorized fixture accepts `tasks.mjs` for bugs and `tasks.mjs` plus `README.md`
  for features. Reject unknown paths, stale before hashes, duplicate/no-op edits,
  additional fields and oversized text. Total source is bounded to 24,000 characters.
  The host writes regular files into exclusively created directories. No target
  dependencies, install scripts, submodules, hooks or repository instructions run.
- The bug scope counts `done === true` and preserves list formatting. The feature
  scope adds ordered name-only JSON, including escaping/empty input, preserves the
  current count/list behavior and documents export. Fixing the separate count bug
  is outside feature scope. These are host-authored accepted fixture proposals,
  not automatically accepted real-project requests.
- Baseline evidence MUST match the accepted source and check set. The bug needs an
  actual value mismatch for its criterion and passing adjacent checks. The feature
  needs an absent export plus passing existing behavior; absence is not a bug or
  success. Documentation presence is a minimal deterministic check; semantic quality
  is reviewed separately. Assertion values are compared on the host. Import/syntax
  errors are `execution_error`, never useful reproduction evidence.
- Candidate text MUST be checked against allowed files and original hashes. The
  exact exported diff MUST apply independently to the accepted base and reconstruct
  the candidate content hash. Retain that proof as `diffAppliedTreeHash`. Verify the
  reconstructed candidate with the same check set and runtime as the baseline.
- The container MUST run rootless on cgroup v2, UID/GID 65534, with network disabled,
  capabilities dropped, no new privileges, default seccomp, private PID/IPC/UTS,
  read-only root/source/harness/runtime, no automatic image volumes/healthcheck,
  no inherited proxy/environment secrets, and no host home/Git/socket mounts.
- Limits: 256 MiB memory including swap allowance, 32 processes, one CPU quota,
  8 MiB temporary storage, 64 open files, 8 MiB file-size limit, no core dumps,
  15-second wall deadline, 64 KiB combined stdout/stderr. Node heap is capped at
  96 MiB. Source/output storage on the host is bounded separately by schemas and
  capture limits. The runtime binary is pinned and copied, then removed after
  confirmed cleanup. No host package/dependency provisioning occurs.
- Container execution returns `passed`, `assertion_failed`, `capability_absent`,
  `setup_error`, `execution_error`, `timeout`, `output_limit` or `cancelled`.
  OOM is explicit metadata on a failed execution. Nonzero exit, malformed/forged
  protocol, missing results or failed cleanup MUST NOT become pass. Preserve
  actual observations separately from model context; expected test data is not
  passed to the patch/review model. The process can still overfit or forge return
  values; these receipts establish observations, not universal correctness.
- Record execution intent with a unique container name before launching. Cleanup
  forcibly removes that specific container. After a crash, inspect the saved intent
  and `podman inspect NAME`; deliberately remove only the recorded fixture container
  before another attempt. No automatic retry or success inferred from absence.
- Reserve one shared two-invocation allowance before provider initialization: patch,
  then separate review. Each has three steps/90 seconds; workflow deadline 300
  seconds. Stop downstream work on setup, cancellation, provider or persistence
  failure. A semantically failing candidate may be reviewed, but cannot be cleared.
  No automatic candidate revision is implemented.
- A verified outcome requires candidate checks passed, exact diff reconstruction
  and a completed review with no blocking findings. Advisory findings remain visible.
  Separate model context does not establish independent human acceptance. The model
  never grants publication authority. Actual cost and immutable Terra revision are unknown.
- Preserve earlier failed trial records. Early development receipts lack optional
  command/definition hashes; absence remains visible. Current receipts link
  `execution.json` (exact argv and container environment) by hash and identify the
  sandbox/check/contracts source definitions. An older blocked diff trial without
  reconstruction proof cannot become `candidate_verified`.

## Derived artifacts

`fixture.json` is authoritative; `fixture.md` and `events.json` are derived.
`base/`, `candidate/`, `patch-check/` and `candidate.patch` preserve source and exact
diff reconstruction. Each verification directory retains read-only work/harness
snapshots, `execution.json` and `observations.json`. Raw artifacts stay ignored.

Common events add `verification.started/completed`, scope/receipt/tree IDs, phase and
allowlisted outcome, plus patch/review reservations and agent events. They exclude
source, diff, prompts, runtime paths, observations and raw diagnostics.

The console's optional `fixtureRoots` (maximum ten) lists saved trials through
`GET /fixtures` and `GET /fixtures/UUID`, with `/json`, `/markdown`, `/events`, `/diff`.
A bounded scan examines up to 300 child directories per root; malformed/conflicting
UUIDs are excluded and incomplete history is visible. HTTP admits no fixture writes.

## References

- Rationale: [ADR-0015](../adr/0015-isolate-fixture-verification-and-scoped-patches.md).
- Context: [fixture design](../design/fixture-execution.md), [change workflow](../design/investigation-to-pr.md).
- Plan: [phases 2–3](../plans/investigation-to-pr.md), [backlog P11/P12](../plans/backlog.md#phase-11--isolated-fixture-verification).
- Evidence: [fixture trial](../plans/records/fixture-patches-2026-09-19.md).
- Runtime option semantics: [Podman run documentation](https://docs.podman.io/en/v5.6.2/markdown/podman-run.1.html); actual qualification used the recorded local version.
