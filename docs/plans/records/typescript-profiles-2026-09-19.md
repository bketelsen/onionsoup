# Evaluation record: Reusable TypeScript tasks — 2026-09-19

Historical evidence appendix to [the evaluation plan](../evaluations.md). This phase
qualifies a second reusable language adapter through the same repository-profile,
accepted-job, patch, review and draft-publication contracts demonstrated for Go.
The trial request is assistant-selected under the user's continuation authority,
not a fetched GitHub issue. Independent maintainer acceptance is not recorded.

## Method and boundaries

The [Onionsoup delivery profile](../../../examples/repository-profiles/onionsoup-delivery.json)
pins Node 24.19.0, its binary digest, public npm integrity-locked dependencies and
fixed offline execution. It selects the complete `test/delivery.test.ts` file and
project typechecking; this is explicitly selected-file coverage, not the full
repository test suite. Test-name filtering and skipped/todo/cancelled test evidence
cannot satisfy that standard check. The original file is append-only.

The [task](../../../examples/project-tasks/onionsoup-schedule-preview.json) proposes
`nextOccurrences`: a read-only preview of 1–14 future delivery occurrences, with
weekday/time-zone handling, first-instant DST-fold identity, gap skipping, input
validation, no argument mutation and a bounded search. The helper does not send
mail, invoke agents or add UI/CLI behavior. The base is
`d47c0878559e0724bb9d12b4c08a8f7b8c4b237b`; only schedule source, delivery tests and
the scheduled-delivery specification may change.

A separate [host check plan](../../../examples/project-tasks/onionsoup-schedule-preview-checks.json)
contains [readable JavaScript check source](../../../examples/project-tasks/onionsoup-schedule-preview-checks.mjs).
The source is frozen before patching and withheld from both workers; check names,
kinds and receipts remain visible. Fixed host commands typecheck, run selected
original tests in full, and call named acceptance-check exports. No task-specific
schedule logic was added to the engine. All live calls use Copilot `gpt-5.6-terra`.

Execution reuses the existing rootless Podman Node sandbox and previously provisioned
npm tree. It has no network, credentials or writable host mounts; limits remain
2 CPUs, 1,536 MiB memory, 128 processes, 128 MiB scratch, 90 seconds and 512 KiB
output. Node, source, dependencies and harness are mounted read-only.

## Engine verification

Full `npm run verify` passed **200 tests, zero failed, zero skipped**, with all
configured integration checks enabled: Node fixture, historical TypeScript profile,
legacy Go profile, reusable Go profile and reusable Node profile. New tests cover
mixed adapters, protected paths, changed test coverage, missing host exports,
missing/skipped/cancelled/todo/duplicate test summaries, altered environments,
withheld assertion source, original-test preservation and shared publication.
The credential-free AgentLayer demo also completed.

Historical publication-filter, bubble-color and no-clobber workflow records
validated under the new implementation. Capability version 5 advertises the
additional adapter within the same worker v2 envelope and accepted job v2; the
older artifacts remain readable without relabeling their outcomes.

## Preserved stops and failures

The initial requirements assessment returned `needs_information`: the request said
to reject invalid input without specifying an observable rejection mechanism. The
assistant clarified the task to require synchronous throws, with no promised error
class/message and no partial result on horizon exhaustion. The initial run remains
stopped; a fresh preparation produced the accepted proposal.

The first candidate passed six of eight checks, including typechecking and the
original delivery suite, but omitted new regression tests and returned the second
fold instant when the first instant was already past. The independent DST check
and changed-test-file check failed, and review/publication were not admitted.
Its record remains `verification_failed`. A fresh attempt used the identical
accepted job, adapter and check plan and ended `needs_information`: after validation
rejected reconstructed original test bytes, the worker requested an append-only
representation. The original file was already present in context; this was an output
reconstruction problem, not a need to read more source.

Following [ADR-0021](../../adr/0021-apply-test-appends-without-model-reconstruction.md),
the host now applies explicit test suffixes bound to the original hash. The patch
prompt was versioned, old prompts/records remained readable, and the unchanged
proposal/task/checks received a new acceptance bound to the revised adapter. This
third attempt is an assisted interface correction, not another identical-condition
sample or an automatic revision loop. No failed candidate was edited by hand.

## Final qualification

- [Draft PR #2](https://github.com/bketelsen/onionsoup/pull/2) is open and unmerged.
  Exact tested head: `eb68e9058ddf1fee83e20b5e5b120d1dbfb3cf61`.
- All **eight** declared candidate checks passed: typecheck, selected original test
  file, existing schedule behavior, basic previews, DST cases, invalid inputs,
  changed regression tests and changed documentation. The selected delivery suite
  ran 18 tests at baseline and 21 after the patch, with zero failures or skips.
- The worker used `operation: append` for three new regression tests covering
  ordinary/weekday previews, a skipped weekly spring minute, a clock between fold
  instants, count bounds and invalid clock/configuration. Original bytes remained
  an exact prefix. Code and documentation used complete replacements.
- Host checks additionally cover strict equality at `now`, 14 weekly occurrences,
  chronological unique identities, configuration/clock preservation, both fold
  positions, and more invalid counts. The search guard and lack of external effects
  were also inspected in the exact diff; finite checks do not exhaust all time zones
  or dates. The implementation reuses existing first-instant selection logic.
- Separate-context Terra review returned `no_blocking_findings`; assistant inspection
  agreed on the bounded scope. File-change checks establish only changed content;
  their names must not be read as independent semantic assertions.
- Final implementation/review took approximately 65 seconds. There were seven
  logical model invocations across preparation and the three implementation attempts;
  the second patch invocation also spent its bounded correction steps. This includes
  the failed/stopped attempts and is not a first-attempt success claim.
- Gitleaks found no leaks in the candidate's 22 reachable commits. Remote draft,
  head, base, title and body matched the approved bundle at publication time.
  GitHub reported no CI checks for this PR; only the recorded local checks are claimed.

Final workflow: `3e65c88d-c34b-4921-a0f6-9f7125a86e11`.
Final accepted job: `42b178ca-326a-4963-808f-eada8f4b1ef1`.
Proposal run: `28627c09-52dd-44c7-ba39-d8c98c392e5b`.
Candidate receipt: `a76ac224-79fb-4e59-bdfc-6c8c0385ef45`.
Final adapter digest: `1b35a5db0c29cce9365abce59ba1689599f2aee099f3af4f27a0e2dda300880a`.
The first two attempts used adapter digest
`ee37169409cdabb7951498bc3e75b1a665f6f4b1b754071b63a852822df3569d`;
acceptance changed explicitly when the edit interface changed, not when checks failed.
The check-plan digest stayed
`bfba7b88b0823ef2da03804b78f7d7ffc54719b6b3da959dab29c81258ef022a`.
Raw records remain ignored under `runs/project-trials/onionsoup-schedule-preview-2026-09-19/`.

Publication replay returned the same draft with one push intent and one PR-create
intent. Console list, detail, JSON and event views returned HTTP 200 with the new
record. These observations were made before the infrastructure push.
The later main-branch infrastructure commit advances the PR base: the receipts remain
bound to the original tested base, not a claim of requalification against every later
main revision. A stale bundle cannot authorize a fresh effect against a changed base.

## Assessment and limitations

This is qualification of one bounded TypeScript task, not a general task-quality
benchmark or complete repository-onboarding product. Profiles require explicit
operator configuration and appropriate independently authored checks. Original
suite selection is visible and narrow. A changed-file predicate proves content
changed, not that new tests or documentation are useful; exact-diff review remains
necessary. No-op host functions and same-process output forgery remain trust
limitations, and the sandbox shares the host kernel.

The first candidate illustrates the distinction between existing tests passing
and a requested feature being correct. Broader testing, independent human acceptance,
new-file creation, native builds and automatic revision/resume remain separate work.

## References

- Rationale: [ADR-0020](../../adr/0020-qualify-typescript-tasks-through-the-shared-profile-contract.md).
- Design: [owned-project changes](../../design/owned-project-changes.md#reusable-typescript-tasks).
- Contract: [repository profiles](../../specs/repository-profiles.md#typescript-adapter).
- Plans: [roadmap Phase 20](../roadmap.md#phase-20--reusable-typescript-tasks),
  [evaluation Phase 18](../evaluations.md#phase-18--reusable-typescript-tasks),
  [change-workflow Phase 8](../investigation-to-pr.md#phase-8--reusable-typescript-tasks).
- Prior evidence: [reusable Go profiles](repository-profiles-2026-09-19.md).
