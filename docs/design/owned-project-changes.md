# Accepted proposals in an owned project

Living document. Rationale: [ADR-0017](../adr/0017-execute-one-accepted-owned-project-proposal.md).
Contract: [owned project changes](../specs/owned-project-changes.md).

## Overview

Explicit host-owned profiles connect operator-authored change requests to existing
requirements/proposal agents, a separately accepted implementation job, bounded
patch/review workers, offline verification and the existing draft publisher.
The targets are `bketelsen/onionsoup` (TypeScript publication filtering) and
`bketelsen/clippy` (Go bubble color and no-clobber). Reusable profiles also
qualify a TypeScript delivery-preview task. This does not qualify arbitrary repositories.
Language separation follows [ADR-0018](../adr/0018-separate-project-policy-from-language-verification.md).

## Design

The original request has a local UUID. It projects into the existing issue-shaped
proposal input using ordinal 1, explicitly labeled as an operator request, never
as a fetched GitHub issue. Bounded pinned excerpts support the proposal. Acceptance
records the exact proposal and requirements run hashes, original full-file context,
base Git tree/commit, profile-specific allowed paths, dependency manifests, profile definition,
criterion-to-check mapping and existing session authority. It is not inferred from
`proposal_ready`. An assistant may accept under explicit operator authorization;
that is recorded separately from independent human code-quality acceptance.

The implementation workers retain the `scoped-patch` and `change-review` jobs.
Version-2 project inputs carry compact proposal results and provenance, not prior
conversations. The reviewer gets separate context containing exact before/after,
diff and receipts. Each workflow reserves at most two invocations, with no revision
loop. Host code applies complete text replacements to a fresh Git index, confirms
changed paths, creates one candidate commit and independently reconstructs its tree
from the exported patch before executing it.

Dependency provisioning copies only the pinned package/lock manifests into a new
private directory. Trusted npm runs `ci --ignore-scripts` with empty user/global
configuration and no inherited credentials. Every lock entry must be an integrity-
pinned public npm registry package. Candidate execution receives the resulting
hash-pinned tree as a read-only mount, with networking disabled. Installation,
registry access and project execution are separate operations.

The runner exports tracked source without Git metadata. The Go profile also
exports unchanged binary assets losslessly under the same path and byte bounds. It mounts source,
dependencies, trusted harness and Node read-only, with bounded scratch space.
Host-owned HTTP scenarios and selected unchanged console tests exercise behavior.
The host evaluates observations; models cannot change the commands or expected
outcomes. Missing filtering is reported as failed new-feature checks, while setup
and existing-behavior failures prevent patch admission. Passing checks provide
finite evidence, not resistance to malicious output forgery or proof of correctness.

Version-2 publication bundles contain the project workflow, and publish the exact
already-tested commit through the same approval, branch lease and create-intent
reconciliation as [fixture publication](draft-publication.md). Version-1 bundles
remain readable. Neither implementation acceptance nor passing checks alone grants
publication authority. Browser input still cannot choose paths, commands or targets.

## Go profile

The same proposal, acceptance, patch, commit-reconstruction, review, event and
publication functions select `clippy-bubble-color-v1` through a closed profile
registry. Agent prompts and submit-only tools are shared. Repository, allowed
files, dependency manifests, required checks and baseline eligibility come from
host policy, never model-selected commands.

Trusted Go provisioning copies only `go.mod` and `go.sum`. It downloads the
checksum-listed public modules with no VCS fallback, target source, credentials,
workspace or toolchain auto-download. Missing transitive dependencies fail offline
execution instead of silently changing manifests. The complete toolchain and module
trees are hashed and mounted read-only. Binary PNG/font resources stay unchanged.

A shared container lifecycle helper enforces timeout, output bounds and cleanup
for both languages. The Go adapter runs build, original tests, vet and gofmt, then
host-owned color tests through an overlay. A private bounded executable tmpfs
holds Go test binaries and build cache; no writable host mount or network is
available. Go checks have distinct IDs and receipts, using the same workflow and
publication contracts. Version-1 jobs and version-2 worker/publication envelopes
add a validated profile alternative without relabeling historical artifacts.

## Reusable repository profiles and tasks

[ADR-0019](../adr/0019-bind-repository-policy-separately-from-task-evidence.md)
separates repository policy from requests under the
[repository-profile contract](../specs/repository-profiles.md). The initial reusable
adapter is `go-module-v1`; historical TypeScript and Go profiles remain supported.
Operator-controlled JSON supplies repository identity, toolchain, standard checks
and path boundaries. A task supplies a pinned base, narrower paths, source excerpts,
request and verification-plan digest. Acceptance records exact resolved runtime
and dependency identities as well as the adapter definition.

Host-owned test source is stored with the workflow but excluded from model input.
Workers receive check kinds and names so a file-change assertion cannot masquerade
as a semantic documentation review. Target tests can be appended to and included
in the PR; independent overlay tests remain frozen. A second Clippy task enters the
same functions through data files rather than feature-specific engine branches.
This implements [Phase 19](../plans/roadmap.md#phase-19--reusable-repository-profiles).

## Operational notes

Only each profile's existing allowed UTF-8 text files may change. No package, workflow or credential edits; reusable profiles permit append-only
regression tests while preserving original bytes. The registry host, execution commands and bounds are
host policy, not model arguments. New dependencies, further projects, a revision loop,
power-loss recovery and hostile multi-tenant execution remain unqualified.
Interrupted execution is preserved for inspection; a new run is explicit.

## References

- Rationale: [ADR-0017](../adr/0017-execute-one-accepted-owned-project-proposal.md).
- Contract: [owned project changes](../specs/owned-project-changes.md), [publication](../specs/draft-publication.md).
- Built in: [Go trial Phase 6](../plans/investigation-to-pr.md#phase-6--go-project-trial), [change-workflow Phase 5](../plans/investigation-to-pr.md#phase-5--one-real-owned-project-change), [roadmap](../plans/roadmap.md).
- Prior evidence: [fixture patches](../plans/records/fixture-patches-2026-09-19.md), [draft publication](../plans/records/draft-publication-2026-09-19.md).

Trial evidence: [reusable repository profiles](../plans/records/repository-profiles-2026-09-19.md).

## Reusable TypeScript tasks

[ADR-0020](../adr/0020-qualify-typescript-tasks-through-the-shared-profile-contract.md)
adds a second reusable language adapter to the [profile contract](../specs/repository-profiles.md#typescript-adapter).
It reuses Node dependency provisioning and isolation while replacing feature-specific
seeds and commands with a profile-selected original suite and separately frozen host
check module. The same requirements, proposal, accepted job, patch, review, events
and publication functions remain shared. [Roadmap Phase 20](../plans/roadmap.md#phase-20--reusable-typescript-tasks)
qualifies the boundary through a read-only delivery-schedule preview task.

[ADR-0021](../adr/0021-apply-test-appends-without-model-reconstruction.md) removes
unnecessary original-test copying from model output: an explicit test append carries
only new bytes and the original hash. Host application and record reconstruction
share one function. The [edit contract](../specs/repository-profiles.md#test-append-edits)
retains complete replacement compatibility and confines appends to approved tests.

TypeScript qualification: [trial evidence](../plans/records/typescript-profiles-2026-09-19.md).
