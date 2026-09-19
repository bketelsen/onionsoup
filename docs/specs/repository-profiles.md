# Spec: Repository profiles and accepted tasks

Operator-controlled repository policy and task evidence feed the shared project
pipeline. Reusable adapters cover root Go applications (`go-module-v1`) and Node 24
TypeScript projects using tsx (`node-typescript-v1`). Historical concrete feature
profiles remain readable and callable. Each adapter requires explicit qualification
of dependencies and selected checks; this is not arbitrary repository onboarding.

## Interface

Canonical schemas are in `src/project-change/repository-profile.ts`. JSON examples
live in `examples/repository-profiles/` and `examples/project-tasks/`.

| Artifact | Responsibility |
| --- | --- |
| Repository profile v1 | Repository slug/numeric ID/base branch; adapter, pinned toolchain version/digest, dependency policy; required checks; allowed/protected paths; file limit; append-only existing tests; draft-only publication |
| Task v1 | Original operator request/title, profile digest, exact base commit, narrowed file list, bounded source excerpts, verification-plan digest and baseline expectations |
| Verification plan v1 | Host-owned Go overlay or Node check source and named check/file-change checks; separate from model context |
| Proposal parent v2 | Frozen profile/task and original requirements/proposal runs with source provenance |
| Accepted job v2 | All original proposal bindings plus profile/task, check summary, runtime/dependency hashes and adapter-definition hash |
| Project workflow v1 | Same workflow envelope, including the independently stored verification plan for replay/inspection, not model context |

```bash
npm run project-change -- validate-task --repository-profile PROFILE.json --task TASK.json --checks CHECKS.json
npm run project-change -- propose --repository-profile PROFILE.json --task TASK.json --checkout REPO --commit SHA --output NEW_PROPOSAL_DIR --provider copilot
npm run project-change -- accept --checkout REPO --proposal PROPOSAL_DIR --mapping MAPPING.json --reason 'Existing authority and scope decision' --runtime RUNTIME.json --dependencies DEPENDENCIES.json --checks CHECKS.json
npm run project-change -- execute --checkout REPO --proposal PROPOSAL_DIR --output NEW_RUN_DIR --runtime RUNTIME.json --dependencies DEPENDENCIES.json --provider copilot
```

The existing Node runtime pinning, `dependencies`, `pin-go`, `go-dependencies`, and exact-bundle publication commands
remain unchanged. `propose --profile ID` still selects a historical concrete
profile; it cannot be combined with repository/task input mode. Profile/task
files are explicit host arguments, never automatically discovered in a target
checkout. Unknown fields, adapters and commands are rejected.

## Rules

- Only configured `bketelsen/*` repositories are eligible. The checkout origin must
  match the profile slug. Draft publication additionally checks numeric repository
  ID, base branch, exact base/head/diff and separate bundle approval. A profile is
  not publication permission.
- `go-module-v1` selects fixed host build/test/vet/format commands; no command strings
  come from task text or model output. It uses the existing offline Go sandbox and
  checksum-pinned dependency provisioning from the [project contract](owned-project-changes.md#go-profile-clippy-bubble-color-v1).
  The toolchain version and complete installation digest must match the profile.
- For Go, standard required checks are exactly `go-build`, `go-test`, `go-vet`, `gofmt`.
  Their successful baseline is mandatory. Task checks declare `pass`, `fail`, or
  `observe` expectations; required baseline failures establish a capability gap,
  not an existing bug claim. Every candidate check must pass.
- Paths support exact names and directory `/**` prefixes only. Task paths must be
  unique, permitted by profile policy, not protected, and within its maximum of
  six files. Host protections always exclude Git metadata, `.github/`,
  `.onionsoup/`, Go/npm manifests, root `tsconfig.json`, `.npmrc`, dependencies and `resources/`. This initial contract
  edits existing regular UTF-8 files only. New-file creation remains unsupported.
- Existing `_test.go` and `*.test.*`/`*.spec.*` JavaScript/TypeScript files are append-only: a candidate must retain every original
  byte as a prefix. This allows useful regression tests in the PR while preventing
  replacement of original test bodies/imports. It does not prove that appended
  code is honest; review and independent checks remain necessary.
- Source excerpts must be within the declared files and exact line bounds, with
  at most seven excerpts and 5,500 characters each. Oversized selections fail rather
  than silently truncating. The original request uses a local ordinal, never a
  fabricated GitHub issue identity.
- The verification plan is supplied by the host and hash-bound before patching.
  A `go-test` check names a declared Go test; fixed commands run it through a
  read-only overlay. Exit zero alone is insufficient: JSON output must contain a
  passing event for that exact test. Missing/skipped tests cannot pass. A collision
  with the reserved overlay filename rejects execution.
- A `file-changed` check only verifies content differs from the accepted base. It
  does not establish documentation accuracy or regression-test quality. The model
  receives these check kinds/paths/names explicitly, and separately reviews meaning.
  Complete test source/expected assertions stay out of patch and review context.
- Every proposal criterion and every required check must be represented in the
  accepted mapping. Semantic relevance is a separate acceptance/review judgment.
- Acceptance is one-shot and binds the profile, task, original proposal, source,
  adapter implementation, manifests, verification plan and resolved runtime and
  dependency descriptors. Execution revalidates those hashes and the mounted
  toolchain/module contents; substitution fails before model work.
- Editing a repository-provided profile or candidate cannot change the current
  run's authority. A changed task/check/profile requires new acceptance. Interrupted
  and failed work is preserved; there is no automatic revision or resume.

## Test append edits

[ADR-0021](../adr/0021-apply-test-appends-without-model-reconstruction.md) adds an
optional `operation` on project edits in the version-2 result envelope. Omitted or
`replace` means complete replacement content, preserving historical results.
`append` means a suffix only, and is accepted exclusively for original test paths
in repository-task jobs. Exact `beforeHash`, unique allowed paths, final 40,000
character file limits and original-prefix preservation remain enforced. Execution
and saved-record validation use the same deterministic concatenation function.

Patch prompt `scoped-patch-project-v2` describes the operation. Historical v1 prompt
runs remain readable. Consumers must understand the capability-version-5 schema;
old clients are not expected to apply the new operation. There are no offsets,
fuzzy matching, new files or implicit operation changes. Appended tests still
require meaningful verification and review.

## TypeScript adapter

[ADR-0020](../adr/0020-qualify-typescript-tasks-through-the-shared-profile-contract.md)
adds `node-typescript-v1`, `offline-node-v1` and `public-locked-npm-v1`. The
profile pins the Node 24 version and binary digest. Acceptance verifies the binary
before executing its version query; the accepted runtime hash additionally binds
the image and dependency descriptors. Provisioning uses integrity-locked public npm
packages with lifecycle scripts disabled; execution is offline and uses no npm scripts.

Standard checks are `node-typecheck` (fixed `tsc --noEmit`) and `node-tests` (fixed
Node/tsx test runner). `verification.testFiles` explicitly selects 1–20 unique
existing `.test.ts`, `.test.js` or `.test.mjs` files. Every selected file runs in
full, sequentially, without a name filter. Both standard baseline checks must pass.
A zero exit alone is insufficient: exactly one TAP summary must report positive
nonempty coverage, all tests passed, and zero failed/cancelled/skipped/todo tests.
Selection is part of the profile hash, not something a task or model can weaken.
This is selected-file coverage, not a claim that the complete repository suite ran.

A Node verification plan holds up to 30,000 characters of host-authored JavaScript
module source and named `node-check` exports (names start with `check`), or
`file-changed` checks. A fixed harness imports the read-only module and calls each
function, awaiting completion. A missing export, import failure or thrown assertion
records failure. Source declarations, adapter identity, unique check IDs and exact
observed coverage are validated. A hung function reaches the sandbox wall deadline;
no partial output is success. The module can import pinned target TypeScript through
`/work/` and the fixed tsx loader. Models see check names and receipts, not assertions.

The adapter retains Node sandbox bounds: 2 CPUs, 1,536 MiB memory, 128 processes,
128 MiB no-execute scratch, 90-second wall deadline and 512 KiB total output.
Typechecking gets a 1,024 MiB V8 heap; selected tests get 512 MiB. Read-only mounts,
no network/credentials, explicit effect authority, and the same-process observation
limitations remain as described in the [project contract](owned-project-changes.md).
Native builds, lifecycle scripts and external-service tests are not qualified here.

Example policy: [Onionsoup delivery](../../examples/repository-profiles/onionsoup-delivery.json).
Example task: [schedule preview](../../examples/project-tasks/onionsoup-schedule-preview.json),
with [checks](../../examples/project-tasks/onionsoup-schedule-preview-checks.json)
and [readable source](../../examples/project-tasks/onionsoup-schedule-preview-checks.mjs).
The checked-in source and JSON source must match. Existing-file and append-only
constraints remain; dynamic imports inside appended tests can use new exports.

## Derived artifacts

The same version-2 worker and publication envelopes carry the version-2 accepted
job. Capability version 5 advertises `repository-task-v1` and preserves historical
profiles. Common events and console artifacts retain the existing workflow/job
identities. Publication uses the task title and exact reviewed candidate commit.

## References

- Rationale: [ADR-0019](../adr/0019-bind-repository-policy-separately-from-task-evidence.md).
- Context: [owned-project design](../design/owned-project-changes.md).
- Prior contract: [owned-project changes](owned-project-changes.md).
- Plans: [roadmap Phase 19](../plans/roadmap.md#phase-19--reusable-repository-profiles),
  [change workflow](../plans/investigation-to-pr.md#phase-7--reusable-repository-profiles).

Trial evidence: [reusable repository profiles](../plans/records/repository-profiles-2026-09-19.md).

TypeScript qualification: [trial evidence](../plans/records/typescript-profiles-2026-09-19.md).
