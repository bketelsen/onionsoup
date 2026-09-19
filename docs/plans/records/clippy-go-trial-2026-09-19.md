# Evaluation record: Clippy Go trial — 2026-09-19

Historical evidence appendix to [the evaluation plan](../evaluations.md). The user
requested a trial in `bketelsen/clippy` to test whether the engine depended on
TypeScript. The assistant selected a bounded `-bubble-color` feature; Clippy had no
open issues at inspection. This is an explicitly labeled local request, not an
invented GitHub issue. Independent human code-quality acceptance is not recorded.

## Method and boundaries

The same requirements/proposal, accepted-job, scoped-patch, change-review,
commit-reconstruction, event and draft-publication functions used in the TypeScript
trial were used for Go. The new [host profile](../../specs/owned-project-changes.md#go-profile-clippy-bubble-color-v1)
sets Go-specific commands, paths, dependencies and baseline eligibility. Agent
prompts, submit-only tools, two implementation invocations and separate publication
authority were retained. All live calls used Copilot `gpt-5.6-terra`.

The accepted target was Clippy `master` at
`19e8772efb43e1e07c09bd3c1153ce55f3230cab`. Only `main.go` and `README.md` were
editable. Original tests, manifests, workflow files, PNG and font remained unchanged.
Execution used pinned Go 1.26.7, rootless Podman 5.4.2 and the existing local Debian
image, with no network, host credentials or writable host mounts. Dependency
provisioning ran separately against only the manifests. Read-only test overlays
provided the fixed new-feature checks.

## Results and evidence

- [Draft PR #8](https://github.com/bketelsen/clippy/pull/8) is open and unmerged.
  Exact head: `7e929884e24e9e2618dfcefa966f2d21dd7dc15e`.
- The feature accepts RGB/RGBA colors with optional `#`, changes the bubble and
  pointer fill, retains default pale yellow and existing behavior, rejects invalid
  input before output, and documents the option.
- All eight fixed checks passed: Go build, complete original test suite, vet,
  formatting, default rendering, color behavior, invalid-input behavior and docs.
  Tests cover both fill regions, transparent/opaque colors, one-unit alpha-rounding
  tolerance, default-image equivalence, independent text/width options, and no PNG
  or file output on invalid input. Baseline passed existing behavior while reporting
  missing new-color support and documentation.
- Separate-context Terra review found no blocking issues and retained limitations.
- Full engine `npm run verify`: **191 passed, zero failed, zero skipped**, including
  real Node fixture, TypeScript project and Go project sandbox checks. Historical
  TypeScript workflow and v2 publication bundle also validated unchanged.
- GitHub's existing Test workflow passed for both branch-push and PR events, using
  its configured Go 1.21 setup: [push run](https://github.com/bketelsen/clippy/actions/runs/35441107512)
  and [PR run](https://github.com/bketelsen/clippy/actions/runs/35441111443).
- Gitleaks scanned all 13 commits reachable from the candidate and reported no
  leaks. Publication replay reconciled to the same draft, with one push intent
  and one PR-create intent. Remote draft state, head/base, title and body matched
  the approved bundle. No merge or other repository mutation was attempted.

Final project workflow: `813bcd7c-d006-4764-8e95-cd99fdabcb67`.
Accepted job: `10c851b6-171e-488e-ad6f-e12639b6d471`.
Proposal run: `72a983e5-c21c-4e2a-861e-94d1ee20ddf2`.
Candidate receipt: `c9574b77-ff2e-4bd6-b602-1b7b0eb04ddd`.
Module-tree digest: `b8c57abbaeced74ce9108ec6612c0cce7bcb9dd91b202cf30151ad4137ff3d0f`.
Profile digest: `b899d9b184eeb1e3be66662a4dccd92860d3609020c62007e9fd6167e3c846b2`.
Raw local artifacts remain under ignored
`runs/project-trials/clippy-bubble-color-2026-09-19/`; the public PR body carries
exact provenance without private transcripts or paths.

## Preserved failures and corrections

`go mod download all` initially fetched a transitive module absent from the
committed checksums. The provisioning attempt was rejected and retained. Provisioning
now requests only checksum-listed modules and verifies both module and go.mod sums;
any missing dependency fails the offline build instead of modifying manifests.

The first live patch passed all seven code/behavior checks but stopped before review
on a host documentation false negative. Its correct README separated `RRGGBB` from
the explanation that `#` is optional. The predicate was corrected and a regression
test added. The first run remains `verification_failed`. The unchanged original
proposal/base was reused with a fresh accepted job bound to the corrected profile;
a fresh patch and review then completed. No failed artifact was rewritten as success.
This required five live logical calls overall: two preparation calls, one first
patch, and the successful patch/review pair. It was not an automatic revision loop.

## Assessment and limitations

The trial demonstrates a shared engine with language-specific host adapters, rather
than a separate Go agent implementation. It exposed real differences: binary assets,
module checksums, complete toolchain pinning and executable scratch for test binaries.
The capability manifests now advertise both profiles at capability version 3, while
historical artifact versions remain readable.

One successful feature is not a broad Go maintenance evaluation. New projects still
need explicit profiles and suitable host checks. The sandbox shares the host kernel;
finite tests and same-process observations do not establish malicious-code resistance
or universal correctness. The deterministic documentation predicate remains lexical,
with meaning assessed separately by model and assistant review. New regression tests
live in the host profile, outside Clippy's unchanged original test suite; the draft
has no newly committed target-side tests. Neither assistant acceptance nor model
review substitutes for independent maintainer approval.

## References

- Rationale: [ADR-0018](../../adr/0018-separate-project-policy-from-language-verification.md).
- Context: [owned-project design](../../design/owned-project-changes.md).
- Contract: [accepted project jobs](../../specs/owned-project-changes.md).
- Plan: [Go evaluation phase](../evaluations.md#phase-16--go-project-trial),
  [change-workflow Phase 6](../investigation-to-pr.md#phase-6--go-project-trial),
  [roadmap Phase 18](../roadmap.md#phase-18--go-project-trial).
