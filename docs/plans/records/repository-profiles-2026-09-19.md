# Evaluation record: Reusable repository profiles — 2026-09-19

Historical evidence appendix to [the evaluation plan](../evaluations.md). This
phase separates reusable repository policy from a particular accepted task and its
host verification. A second Clippy feature exercises the shared pipeline with
committed regression tests. Independent maintainer code-quality acceptance is not
recorded.

## Method and boundaries

The [repository profile](../../../examples/repository-profiles/clippy.json) pins
repository identity, branch, Go toolchain, offline adapter, dependency policy,
standard checks, allowed/protected paths, append-only original tests and draft-only
publication. The [task](../../../examples/project-tasks/clippy-no-clobber.json)
narrows paths, pins the base, supplies the request and context selections, and binds
an independently authored [check plan](../../../examples/project-tasks/clippy-no-clobber-checks.json).
Its [readable test source](../../../examples/project-tasks/clippy-no-clobber-tests.go.txt)
is checked against the plan. Acceptance freezes these artifacts with runtime and
dependency manifests. Target content and model output cannot grant authority.

The chosen local feature request is opt-in `-no-clobber` output protection; it is
not an invented GitHub issue. Clippy `master` was pinned to
`19e8772efb43e1e07c09bd3c1153ce55f3230cab`. Only `main.go`, `main_test.go` and
`README.md` could change. Original test bytes, including imports, had to remain an
exact prefix. All live model calls used Copilot `gpt-5.6-terra`.

The Go adapter supplies build, test, vet, formatting and named host-test execution.
Task-specific behavior lives in supplied artifacts, not engine branches. The
previous bubble-color task also validates against the same profile through a
[migration example](../../../examples/project-tasks/clippy-bubble-color.json);
this does not claim another live bubble-color trial. Historical concrete Go and
TypeScript workflows remain readable and callable.

Execution reused pinned Go 1.26.7 and checksummed Clippy modules in rootless Podman:
no network, credentials or writable host mounts; read-only source, toolchain,
modules and host tests; 2 CPUs, 2 GiB memory, 128 processes, 768 MiB scratch,
180-second wall limit and bounded output. Named host checks require both a zero
exit status and the exact test's JSON pass event; skipped or absent tests fail.

## Results and evidence

- [Draft PR #9](https://github.com/bketelsen/clippy/pull/9) is open and unmerged.
  Exact head: `122dd1bc5e6c114db55065b330d6744e88059a73`.
- The candidate uses atomic exclusive creation for filesystem output and preserves
  the default overwrite behavior and PNG stdout. Existing-file errors retain the
  wrapped `os.ErrExist`; explicit and generated names receive the same protection.
- All **nine** candidate checks passed: build, full project tests, vet, formatting,
  overwrite compatibility, protected file behavior, stdout behavior, changed tests
  and changed documentation. The baseline passed the four standard checks and
  overwrite compatibility while exposing missing feature/tests/docs.
- Two regression tests are committed to Clippy: existing-target rejection without
  a success filename, and decodable PNG stdout with the flag. Original test bytes
  were preserved. Host tests additionally check exact existing-file preservation,
  wrapped errors, generated names, successful new-file PNGs and explicit false.
  The committed tests do not independently cover all those host assertions.
- Separate-context Terra review reported no blocking findings. Assistant inspection
  confirmed the exact diff, exclusive-open flags, test additions and README meaning.
  File-change checks establish changed content, not semantic adequacy; neither
  review is independent human acceptance.
- Engine `npm run verify`: **196 passed, zero failed, zero skipped**, including real
  Node fixture, TypeScript project, legacy Go and reusable Go sandbox checks.
  Boundary tests reject broadened paths, stale hashes/environment/checks, weakened
  original tests, missing named-test evidence and mismatched numeric publication
  targets. Historical TypeScript and Go workflow records also validated.
- Existing GitHub Test jobs passed on both [push](https://github.com/bketelsen/clippy/actions/runs/35460113570)
  and [PR](https://github.com/bketelsen/clippy/actions/runs/35460117197), separately
  from local receipts.
- Gitleaks found no secrets in 13 commits reachable from the candidate. Publication
  replay returned the same draft with one push intent and one PR-create intent.
  Remote title, body, head, base and draft state matched the approved bundle.
  Console list, detail, JSON and events returned HTTP 200 with the new record.

The adapter digest remained
`2889d6009be9936ae9de6e93b949ac75ec3a64100c67ad0bef94d3978526e4e9`
through both implementation attempts. Repository profile digest:
`e43e78befb10abbb1a1be75e5cdea00bff888af1911331cbc9625439274d076e`.
Task digest: `e5dc3328f11c57a379691827b74d1e7d8a89e48caede7090841b93c7ab2d2c44`.
Checks digest: `b04c4c76c9913b0995dedcec6f2427e25f7b4dffe9c22b3e582b8fb18bb855c8`.
Accepted job: `df1de488-2679-49a3-8932-10bec7dd5e76`.
Final workflow: `1c32abf0-4883-4776-9e1e-06f4e29410a2`.
Candidate receipt: `9e1a28c7-2de7-4b7b-8bd8-720dea7cf1b1`.
Raw artifacts remain ignored under `runs/project-trials/clippy-no-clobber-2026-09-19/`.

## Preserved preparation and failure

The first ready proposal made generated default filenames explicit. Before
acceptance, the host plan was strengthened to test that case and the task's check
hash updated. That proposal remains unaccepted; a fresh proposal with the final
artifacts was accepted. This was preparation, not a repair of failed patch evidence.

The first implementation passed eight of nine checks but contained one stray space
in an appended test. Formatting failed, so the workflow stopped before review. Its
record remains `verification_failed`. A fresh attempt under the same accepted job,
checks and adapter passed all nine checks and review. No candidate was manually
repaired or failed record rewritten. Across both preparation runs and both
implementation attempts there were seven logical model calls; the final execution
took approximately 72 seconds. This is not an automatic revision loop.

## Assessment and limits

The phase demonstrates a second task expressed as data using the shared execution,
review and publication functions. Policy reuse and evidence separation are useful
without adding another agent or orchestrator. This is a bounded Go qualification,
not general repository onboarding. The legacy TypeScript task remains supported;
a reusable TypeScript adapter is still deferred. Only existing regular files can
change, and append-only tests cannot modify imports. Profiles are supplied by the
operator rather than automatically trusted from a target checkout.

Host-authored checks still require careful work, as the generated-name preparation
showed. The sandbox shares the host kernel, and same-process observations are not
proof against malicious output forgery. Finite checks and one successful new task
do not establish broad maintenance accuracy. Publication approval records the
user's delegated draft authority; merging and independent acceptance remain separate.

## References

- Rationale: [ADR-0019](../../adr/0019-bind-repository-policy-separately-from-task-evidence.md).
- Design: [owned-project changes](../../design/owned-project-changes.md).
- Contracts: [repository profiles](../../specs/repository-profiles.md),
  [accepted jobs](../../specs/owned-project-changes.md),
  [draft publication](../../specs/draft-publication.md).
- Plans: [roadmap Phase 19](../roadmap.md#phase-19--reusable-repository-profiles),
  [evaluation Phase 17](../evaluations.md#phase-17--reusable-repository-profiles),
  [change-workflow Phase 7](../investigation-to-pr.md#phase-7--reusable-repository-profiles).
