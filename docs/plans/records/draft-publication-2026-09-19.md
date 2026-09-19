# Evaluation record: Owned-fixture draft publication — 2026-09-19

Historical evidence appendix to [the evaluation plan](../evaluations.md).
This completes change-workflow Phase 4 / backlog P13. Evidence combines scripted
failure tests, live GitHub publication, and assistant inspection. The user explicitly
authorized draft tests in `bketelsen` repositories; independent human code-quality
acceptance was not measured.

## Method and boundaries

Reused the two corrected verified candidates from the [fixture trial](fixture-patches-2026-09-19.md).
No new agent calls or model evaluations were needed. Their original Copilot/Terra
patch and separate review evidence remains unchanged, including the feature's
README advisory. The candidate reviews' historical notes about requiring authority
are preserved; separate publication approvals record the later user authorization.

Provisioned the public owned fixture repository `bketelsen/onionsoup-fixtures`
(numeric identity `1376912929`) with each original base commit on its own branch.
No dependencies, workflows, installation scripts or production files were added.
The publisher itself does not provision repositories or base branches.
No branch, issue, PR or other object was changed in `get-bb/bb`.

Prepared version-1 bundles with complete fixture evidence, exact candidate commits,
diffs and draft text. Inspected both concrete bundles, recorded existing explicit
session authority with its provenance, and used the deterministic CLI publisher.
Approval binds the complete bundle/configuration hashes and expires after 24 hours.
No merge, reviewer assignment, labels or comments were requested or performed.

## Results and evidence

| Kind | Draft | Base commit | Candidate commit |
| --- | --- | --- | --- |
| Bug | [#1](https://github.com/bketelsen/onionsoup-fixtures/pull/1) | `64fcb41a596307436b1404d749446dfc37e4423b` | `a1ace71f382cbb9a59ad11fba3153fe829a33a3a` |
| Feature | [#2](https://github.com/bketelsen/onionsoup-fixtures/pull/2) | `451ec9248ff202b6026869e032f811fab438dbb2` | `2efafacec653bd550bde5b2e7f411badeff2b82a` |

Bug publication identity:
`4663e56ab5eed8ff166f971ff3f28484e4d0edfa25b84b989597d685d54d02b5`.
Bundle digest: `01cfdd96999db36524b17850b039e3baed2748416c7f1a3d46a60ae392d8c65b`.

Feature publication identity:
`b86766ad7f14ac560d05c00d739fb9fad1e72cb1d9cc13e044cbac9f124eab76`.
Bundle digest: `79f18cb01e212cd414ac941289f787e521864ca934f8d759ba1cd1866d58942a`.

Both were observed open and draft, with the exact configured repository identity,
base/head commits, branch names and approved title/body. Repeating publication
returned the same two PRs. Only two PRs existed after the live trial. The bug changed
one boolean comparison; the feature added JSON export plus documentation. Existing
candidate checks and finite-coverage limits are described in each PR; no GitHub CI
execution or independent human code acceptance is claimed.

The first bug publication attempt recorded `unknown` during remote inspection,
before either a push or PR-create intent. The adapter had assumed `/usr/bin/gh`, but
this host installs `gh` through Homebrew. Resolving `gh` through the configured host
PATH corrected the setup. The next invocation used the same identity and approval,
then published successfully. The original unknown observation remains in the journal.
There were no live lost-PR-response tests; those crash windows were scripted.

Local evidence lives under ignored `runs/publication-trials/2026-09-19/`; configuration
is private under `.local/publication/`. The deployed console exposes `/publications`,
exact bundle pages, JSON and common workflow events. HTTP responses and rendered HTML
were checked. A browser was unavailable to the computer-use tool, so this is not a
visual browser qualification. Existing capture services and the daily timer remained
active. Secret scans of both candidate commit histories found no leaks.

Software tests cover exact bug/feature commits, unauthorized third-party targets,
changed configuration/bundle, stale base, expired approval (including during push),
conflicting branches, absent approvals, lost push/create responses, late visibility,
checkpoint failure before/after effects, altered/closed/non-draft/duplicate PRs,
base races, concurrent consumers and stale locks, and console CSRF/field boundaries.
`npm run verify` passed documentation, generated schemas, TypeScript and all 180 tests with real sandbox qualification enabled (zero skips). The credential-free AgentLayer demo also passed. These test runtime and authority behavior, not general patch accuracy.

## Limitations and next step

Only the owned dependency-free two-file fixture is supported. Raw evidence remains
local; public PRs contain criterion-specific summaries and hashes. A distinct model
review is not independent human acceptance. An ambiguous create with no observable
result stays unknown and cannot be retried automatically. GitHub base locking is
not transactional, and independent state roots do not provide distributed exclusion.
Atomic file replacement is not a power-loss durability qualification. Stale locks
and failed preparation directories require operator inspection.

Next: connect a concrete accepted proposal from an owned project to bounded source
selection and a project-specific dependency/verification profile. Broader execution
and arbitrary-repository publication remain unqualified; there is no autonomous
revision or merge loop.

## References

- Plan phase: [evaluation Phase 14](../evaluations.md#phase-14--approved-draft-publication), [change-workflow Phase 4](../investigation-to-pr.md#phase-4--explicit-draft-publication).
- Context: [publication design](../../design/draft-publication.md), [validation](../../design/validation.md).
- Contract: [draft publication](../../specs/draft-publication.md).
- Rationale: [ADR-0016](../../adr/0016-publish-only-approved-fixture-bundles.md).
