# Spec: Accepted owned-project implementation jobs

Host-owned profiles implement one feature each in `bketelsen/onionsoup` and
`bketelsen/clippy`. They do not expose an arbitrary repository runner. The original
TypeScript profile remains the CLI default. The following original rules apply
to it; the Go-specific alternatives are defined below.

## Interface

Canonical schemas and functions live in `src/project-change/`. Commands:

```bash
npm run project-change -- propose --checkout REPO --commit SHA --output PROPOSAL_DIR --provider copilot
npm run project-change -- accept --checkout REPO --proposal PROPOSAL_DIR --mapping MAPPING.json --reason 'Existing user authorization and assistant scope decision'
npm run project-change -- dependencies --checkout REPO --commit SHA --output NEW_DEPENDENCY_DIR
npm run project-change -- execute --checkout REPO --proposal PROPOSAL_DIR --output NEW_RUN_DIR --runtime RUNTIME.json --dependencies DEPENDENCIES.json --seed FIXTURE_BUNDLE.json --provider copilot
npm run project-change -- prepare-publication --project RUN_DIR --config PUBLICATION_CONFIG --target-index 0
```

Output directories must be new and their parent directories must exist. The fixed
operator requests are defined in `profiles.ts`. The seed is a previously validated
version-1 owned-fixture publication bundle; the host derives local test-only history
records for all publication statuses. Those seeds never authorize remote effects.
Their exact hash binds baseline and candidate checks. Raw outputs remain private.

| Artifact | Meaning |
| --- | --- |
| `proposal.json` | Original operator request, pinned context, requirements/proposal records, two reserved invocations and completion state |
| `job.json` | One-shot accepted proposal hash, compact result/provenance, base commit/tree, source and manifest hashes, allowlist, check mapping, profile hash and authority |
| `dependencies.json` | Manifest hashes, installed tree digest, Node/npm identities, registry, scripts-disabled policy and timestamp |
| `project.json` | Accepted job plus original proposal evidence, runtime/dependencies/seeds, baseline/candidate receipts, patch/review records, exact diff/commit/tree and outcome |
| Verification directory | Intent with exact command, private bounded observations and materialized read-only source/harness |
| Publication bundle v2 | Exact project workflow/hash, base/head/tree/diff/title/body, target/config identities; shared approval journal |

`mapping` is an array of `{criterionId, checks}`; every proposal criterion and every
fixed check must be represented. IDs are `default-history`, `status-filter`,
`invalid-filter`, `filter-controls`, `coverage-preserved`, `detail-unchanged`,
`documentation`, `typecheck`, `adjacent-console`. Mapping expresses the accepting
operator's judgment; structural coverage alone does not establish semantic relevance.

## Rules

- Only completed, matching requirements/proposal runs with `proposal_ready` and no
  blocking questions may be accepted. Original proposal records retain their
  read-only meaning. Acceptance is one-shot and names who accepted under which
  authority; it never claims independent human review on the assistant's behalf.
- Allowed files are exactly `src/publication/console.ts`, `src/console/server.ts`,
  `docs/specs/draft-publication.md`. Paths, source hashes, base, profile, lockfile,
  criterion map and proposal revision are frozen. Mutation of any invalidates the job.
- Patch/review input/result/run version 2 preserves version-1 fixture readers and
  calls. Capability manifests advertise the project profile separately. Workers
  have only `submit_result`; three steps, 180 seconds per call, two calls per
  implementation workflow, 15 minutes total. Proposal preparation has its existing
  separate two-call budget. Provider/model stay explicit: Copilot/Codex, Terra.
- No implementation conversation enters review. Edits must have exact before hashes
  and complete replacement contents; unknown paths, duplicates and no-ops fail.
- Candidate commit has exactly the accepted parent. Only allowed regular text files
  may differ. The exact patch must independently reconstruct the candidate Git tree.
- npm installation uses only public registry tarballs with SHA-512 integrity from
  the unchanged lockfile, `--ignore-scripts`, isolated cache/home and empty npm
  configuration. No target source or credentials enter provisioning. The installed
  dependency tree, including link targets and modes, is hashed and rechecked.
- Execution requires the existing rootless Podman/cgroup-v2 pinned runtime. No image
  pulls, network, credentials, Git metadata or writable host mount. Read-only source,
  dependencies, Node and host harness; UID 65534, no capabilities, no-new-privileges,
  private namespaces, 1536 MiB memory, 128 PIDs, two CPUs, 128 MiB noexec scratch,
  90 seconds and 512 KiB combined output. Forced cleanup targets the exact named
  container. A failed intent checkpoint prevents launch; cleanup failure is failure.
- The trusted harness starts the local HTTP server inside the isolated namespace,
  supplies status-varied saved history, observes list/filter/invalid/detail routes,
  runs TypeScript and selected original console tests. Models cannot edit checks.
  Host evaluation records each fixed check. Documentation has a limited deterministic
  check plus model/assistant review; it is not a semantic documentation proof.
- Baseline setup, default history, detail, coverage, types and adjacent tests must
  pass before patch admission. New-feature check failures remain explicit gaps.
  A candidate needs every check to pass and no blocking review findings.
- Preserve every failed/unfinished attempt. No automatic revision, resumed model
  call, merge or third-party publication. Local interrupted state requires inspection.
- Project publication is version 2 under the existing [publication contract](draft-publication.md).
  It must target the job's exact configured repository, base and candidate. Approval
  remains a separate exact-bundle effect authorization.

## Go profile: `clippy-bubble-color-v1`

Select this profile explicitly for `bketelsen/clippy`; its allowed regular text
files are exactly `main.go` and `README.md`. The operator-authorized feature adds
`-bubble-color`, accepts RGB/RGBA hex with optional `#`, preserves default `#FFFFBE`
and unrelated behavior, rejects invalid colors before output, and documents it.
The request is local ordinal 1, not a fetched GitHub issue. Original tests, PNG,
font, manifests and workflow files cannot change.

```bash
npm run project-change -- pin-go --image IMAGE_ID --go-directory GO_ROOT --output NEW_RUNTIME.json
npm run project-change -- go-dependencies --checkout REPO --commit SHA --runtime RUNTIME.json --output NEW_DEPENDENCY_DIR
npm run project-change -- propose --profile clippy-bubble-color-v1 --checkout REPO --commit SHA --output PROPOSAL_DIR --provider copilot
# accept uses the same mapping/reason command; execute uses the same command without --seed
```

- Job `profile` determines the repository, exact path set, manifest semantics and
  required check IDs. Foreign profile paths/checks/runtime/dependencies are rejected.
  Existing job/workflow v1 and worker/publication v2 formats gain an additive
  profile alternative; historical artifacts keep their versions and identities.
- Go runtime v2 records a pinned local image, Go installation directory, complete
  installation digest, Go version and Podman version. Go dependency v2 records
  complete module-tree digest, toolchain identity, timestamp, public proxy/checksum
  database and original manifest hashes. `packageHash` means `go.mod` and `lockHash`
  means `go.sum` in this profile. No npm/Node dependency is used to build the target.
- Provisioning downloads only `go.sum`-listed modules using the trusted local Go
  toolchain, `https://proxy.golang.org`, and `sum.golang.org`. Downloaded module and
  go.mod checksums must match the original file; manifests must remain unchanged.
  Reject replacement/exclusion/toolchain directives and unsupported checksum hosts.
  No target code executes during provisioning. Workspace, user config, Go auth,
  toolchain downloads and VCS fallback are disabled. Unavailable required modules
  fail closed during offline build.
- Source export admits regular binary blobs unchanged for Go, up to 2,000 entries
  and 8 MB total. Submodules, escaping links, unsafe paths and Git metadata remain
  rejected. Editable files must remain UTF-8 text. Read-only toolchain/modules/source
  and harness are the only host mounts.
- The rootless container uses no network, credentials, capabilities, automatic image
  pulls or writable host mounts. UID 65534, private namespaces, no-new-privileges,
  2,048 MiB memory, 128 PIDs, two CPUs, 180 seconds, 512 KiB output and 768 MiB private
  executable scratch. Executable scratch is required for Go binaries; it is explicitly
  different from Node's noexec scratch. CGO, workspace, telemetry, module network,
  VCS stamping and toolchain downloads are disabled. Modules are readonly.
- Fixed commands run `go build`, all original `go test ./...` tests, `go vet ./...`,
  and `gofmt -l main.go`. Host-owned tests enter through a read-only Go overlay,
  outside the patch allowlist. Checks are `go-build`, `go-test`, `go-vet`, `gofmt`,
  `bubble-default`, `bubble-colors`, `bubble-invalid`, and `documentation`.
- Baseline admission requires build/test/vet/format/default checks. New feature
  failures are explicit capability gaps. Candidate acceptance requires all eight.
  Color checks sample bubble and pointer interiors, RGB/RGBA and transparent fills,
  compare default renderings, preserve independent text-color/width options, and
  verify invalid input creates neither stdout PNG nor an output file. One channel
  unit allows alpha conversion rounding. Documentation checks are limited lexical
  checks plus separate review, not semantic proof.
- The two implementation invocations, exact accepted scope, commit reconstruction,
  separate-context review and separately approved draft publication are unchanged.
  No revision loop or merge is introduced. The shared-kernel sandbox and tests do
  not establish hostile-code isolation or exhaustive image correctness.

## Reusable task input

The [repository-profile contract](repository-profiles.md), under
[ADR-0019](../adr/0019-bind-repository-policy-separately-from-task-evidence.md),
adds separately bound policy/task/check artifacts and accepted job v2 to the same
functions. It qualifies reusable Go tasks and preserves these historical profiles.

## Derived artifacts

Common workflow events expose accepted job, parent request and worker identities,
reservations, verification receipts and outcomes, without source, prompts, prose or
private paths. The generic `assertion_failed` trace value means checks failed;
the project record retains feature semantics and individual check results.
The publication console reads both bundle versions and their evidence.

## References

- Rationale: [ADR-0018](../adr/0018-separate-project-policy-from-language-verification.md), [ADR-0017](../adr/0017-execute-one-accepted-owned-project-proposal.md).
- Context: [owned-project design](../design/owned-project-changes.md).
- Plan: [Phase 5](../plans/investigation-to-pr.md#phase-5--one-real-owned-project-change).
- Go dependency policy: [Go modules reference](https://go.dev/ref/mod#go-mod-download).
- Dependency policy: [npm ci documentation](https://docs.npmjs.com/cli/v11/commands/npm-ci/).
