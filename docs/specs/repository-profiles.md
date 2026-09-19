# Spec: Repository profiles and accepted tasks

Operator-controlled repository policy and task evidence feed the shared project
pipeline. This phase qualifies the reusable `go-module-v1` adapter for root Go
applications. Historical Go and TypeScript feature profiles remain readable and
callable; generic TypeScript onboarding is not qualified by this contract.

## Interface

Canonical schemas are in `src/project-change/repository-profile.ts`. JSON examples
live in `examples/repository-profiles/` and `examples/project-tasks/`.

| Artifact | Responsibility |
| --- | --- |
| Repository profile v1 | Repository slug/numeric ID/base branch; adapter, pinned Go version/digest, dependency policy; required checks; allowed/protected paths; file limit; append-only existing tests; draft-only publication |
| Task v1 | Original operator request/title, profile digest, exact base commit, narrowed file list, bounded source excerpts, verification-plan digest and baseline expectations |
| Verification plan v1 | Host-owned Go overlay source and named test/file-change checks; separate from model context |
| Proposal parent v2 | Frozen profile/task and original requirements/proposal runs with source provenance |
| Accepted job v2 | All original proposal bindings plus profile/task, check summary, runtime/dependency hashes and adapter-definition hash |
| Project workflow v1 | Same workflow envelope, including the independently stored verification plan for replay/inspection, not model context |

```bash
npm run project-change -- validate-task --repository-profile PROFILE.json --task TASK.json --checks CHECKS.json
npm run project-change -- propose --repository-profile PROFILE.json --task TASK.json --checkout REPO --commit SHA --output NEW_PROPOSAL_DIR --provider copilot
npm run project-change -- accept --checkout REPO --proposal PROPOSAL_DIR --mapping MAPPING.json --reason 'Existing authority and scope decision' --runtime RUNTIME.json --dependencies DEPENDENCIES.json --checks CHECKS.json
npm run project-change -- execute --checkout REPO --proposal PROPOSAL_DIR --output NEW_RUN_DIR --runtime RUNTIME.json --dependencies DEPENDENCIES.json --provider copilot
```

The existing `pin-go`, `go-dependencies`, and exact-bundle publication commands
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
- Standard required checks are exactly `go-build`, `go-test`, `go-vet`, `gofmt`.
  Their successful baseline is mandatory. Task checks declare `pass`, `fail`, or
  `observe` expectations; required baseline failures establish a capability gap,
  not an existing bug claim. Every candidate check must pass.
- Paths support exact names and directory `/**` prefixes only. Task paths must be
  unique, permitted by profile policy, not protected, and within its maximum of
  six files. Host protections always exclude Git metadata, `.github/`,
  `.onionsoup/`, Go manifests, dependencies and `resources/`. This initial contract
  edits existing regular UTF-8 files only. New-file creation remains unsupported.
- Existing `_test.go` files are append-only: a candidate must retain every original
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

## Derived artifacts

The same version-2 worker and publication envelopes carry the version-2 accepted
job. Capability version 4 advertises `repository-task-v1` and preserves historical
profiles. Common events and console artifacts retain the existing workflow/job
identities. Publication uses the task title and exact reviewed candidate commit.

## References

- Rationale: [ADR-0019](../adr/0019-bind-repository-policy-separately-from-task-evidence.md).
- Context: [owned-project design](../design/owned-project-changes.md).
- Prior contract: [owned-project changes](owned-project-changes.md).
- Plans: [roadmap Phase 19](../plans/roadmap.md#phase-19--reusable-repository-profiles),
  [change workflow](../plans/investigation-to-pr.md#phase-7--reusable-repository-profiles).

Trial evidence: [reusable repository profiles](../plans/records/repository-profiles-2026-09-19.md).
