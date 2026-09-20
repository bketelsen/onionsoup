# Evaluation record: Workflow owners and model delegation — 2026-09-20

Historical evidence appendix to [the evaluation plan](../evaluations.md), phase 24.
This records scripted boundary checks and assistant-reviewed Copilot/Terra trials;
there is no independent operator acceptance or production reliability estimate.

## Method and boundaries

Starting revision `90865f7`, with the phase-26 changes in the commit containing this
record. Node 24.19.0; AgentLayer 0.0.36; MCP SDK 1.30.0; `gpt-5.6-terra` via the
configured Copilot subscription, without fallback. Workload source v2 uses five
fixed status projections; current triage prompt v4 retains three steps/90 seconds.
The final consumer prompt is `homelab-delegation-v3`, with eight parent steps,
twelve delegated tool calls, one investigation, one brief and 360-second deadline.

A bounded owner-reference read identified `argoproj.io/v1alpha1` Workflow owners
for the fresh snapshot's three failed pods. One previously sampled pod had been
replaced, so historical observations were preserved and new evidence collected.
No logs, free-form event/error text, Workflow specs or mutation were used. Model
context contained normalized facts and hashed resource IDs, not private names.

Twelve fixture expectations were defined separately from model input: completed
Job, replacement, crash loop, missing owner, partial collection, stale snapshot,
and Workflow success, failure, error, running-with-failed-pod, missing owner and
stale evidence. These are synthetic boundary examples, not a representative fleet.

## Results and evidence

### Fixture evaluations

- Prompt v3 batch `0827e7ac-53ff-4066-b485-435e336cc102`: 12/12 final labels matched.
  Partial collection required two steps after an `INVALID_EVIDENCE` rejection.
- Prompt v4 batch `fc150e86-b72e-4c7b-9377-49998e22fdc3`: 12/12 labels matched in
  one step each. Assistant review found reasons consistent with supplied evidence,
  including explicit stale/missing coverage and execution-versus-outage distinctions.
  Host prerequisites constrain confidence; this does not independently validate
  every semantic claim or establish model accuracy on a broader corpus.

Private artifacts are under `runs/workload-evaluation/BATCH/` and remain ignored.

### All conversational attempts

| Parent run | Consumer / triage prompt | Outcome |
| --- | --- | --- |
| `ca4fe712-d89c-4cab-bd40-6fee1364140b` | v1 / v3 | Failed after eight steps. Triage completed in two steps; the brief call included schema metadata as arguments. MCP rejected it. |
| `dd96dcf0-25f1-4ccd-8c49-57c83a0ea01b` | v2 / v3 | Failed after eight steps. Child exhausted three steps with `RECOVERY_NOT_ESTABLISHED`; parent repeated inspection without a usable result. |
| `e1b0a35a-783b-47be-b94c-cbf0e9a246af` | v2 / v4 | Runtime completed in four steps; child completed in one. Assistant review caught a summary miscount: four historical findings instead of five. Not qualified as a correct summary. |
| `8c44541b-83c4-45de-8649-ba92594680f2` | v3 / v4 | Completed in four steps; child completed in one. Host counts and assistant-reviewed explanation agree with the saved findings and limitations. |

The first failure prompted explicit executor parsing (published schemas alone did
not enforce the consumer callback) and a scalar brief argument mapped to the MCP
array contract. The second prompted per-pod prerequisites, actionable correction
feedback and immediate parent termination on a failed child. The third prompted
host-derived counts in MCP, saved briefs, consumer context and final answers.
Earlier artifacts were neither overwritten nor relabeled.

Final provenance:

- Parent directory `runs/homelab-delegation/53a65e9b-ca54-4231-b965-559d42d79549/`.
- Investigation job `76cf7a27-4ab2-4a28-9d78-981c61ed24e5`.
- Source run `5c0cb82e-e1d1-4ca8-80c7-a5a1d9840113`.
- Triage run `bb7c141b-5c4c-4123-bc2c-435525ca5f90`.
- Brief job `462664b3-85cd-4e44-bf3f-0ce79490c8c1`.

The actual model selected discovery, investigation and brief composition through
compiled stdio MCP, then submitted its answer. This extends the earlier scripted
protocol proof to real model delegation. No service changes occurred.

Final source: all five sections collected, 16 eligible pods, 10 selected, six
explicitly omitted. Among selected findings:

- Three warrant execution review: one owning Workflow reports Running with no
  completion time; two report Failed with valid completion times. These are not
  diagnoses or proof of current outages. Later scheduled-run recovery is unknown.
- Five historical restart findings have ready/current ReplicaSet evidence.
- Two remain insufficient: StatefulSet and DaemonSet status was not collected.

The workload observation was fresh at assessment. The four configured baseline
NAS/container/aggregate-cluster observations were stale; both the brief and final
answer retained that limitation. The final brief does not establish current health
of those other sources. Containers on one host additionally retain partial coverage.

Final parent usage: 10,108 input / 380 output tokens; child triage: 8,033 input /
1,992 output tokens. Combined recorded usage: 18,141 input / 2,372 output. This is
provider-reported token usage for that successful attempt, not a dollar-cost or
HTTP-request measurement. Earlier attempts consumed additional recorded usage.

### Runtime checks

`npm run verify` with pinned TypeScript/Go fixture profiles and a fresh portable
release install passed: 252 tests, none failed or skipped. Checks cover narrow
commands, owner API identity, invalid/missing timing, stale/partial coverage,
correction, cross-job authority, malformed extra arguments, reservations,
cancellation, failed-child termination, persistence and existing release boundaries.
Full-suite concurrency also exposed an inspection race: reading an old admission
while its job settled could briefly report unfinished. Inspection now preserves
the in-flight observation across that read. A previously saved v2-prompt/v1-source
live triage parsed unchanged. Published
capability v2 includes both source schema versions; generated drift checks pass.

## Limitations and next step

One corrected successful conversational trial does not establish general chat
reliability. Summary prose remains model-generated even though counts and job
provenance are deterministic. Private saved artifacts are inspectable but cannot
resume after a crash. The host remains stdio and operator-configured.

The next bounded experiment is a reusable conversational consumer with explicit
freshness/refresh policy and regression requests for failed/unknown evidence. Add
StatefulSet/DaemonSet projections only for the remaining demonstrated evidence gap;
retain controller-specific recovery rules. No repair authority follows from this
qualification. Scheduler/successor history and all service mutation remain separate.

## References

- Plan: [evaluation phase 24](../evaluations.md#phase-24--workflow-owners-and-conversational-delegation-qualification),
  [roadmap phase 26](../roadmap.md#phase-26--workflow-owners-and-model-delegation).
- Context: [package design](../../design/packages-and-recipes.md),
  [validation](../../design/validation.md).
- Contracts: [workload triage](../../specs/workload-triage.md),
  [model delegation](../../specs/homelab-delegation.md).
- Rationale: [ADR-0027](../../adr/0027-observe-workflow-owners-and-prove-model-delegation.md).
