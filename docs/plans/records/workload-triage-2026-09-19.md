# Evaluation record: Workload triage — 2026-09-19

Historical evidence appendix to [the evaluation plan](../evaluations.md), phase 23.
Tests, synthetic model evaluations and assistant-reviewed live snapshots are separate
below. There was no independent human review or remediation.

## Method and boundaries

Base revision `2959326` plus the workload-triage changes delivered with this report.
Node 24.19.0, AgentLayer 0.0.36, Copilot subscription, `gpt-5.6-terra` only. Source
command version `k3s-workloads-v1`; four fixed reads with 20-second/256-KiB per-read
bounds and an 85-second admission deadline. Agent: three logical steps, 90-second
cooperative timeout, one invocation per 180-second investigation. Host MCP jobs:
one concurrent job, four admissions per process in this trial.

Six synthetic fixtures declared expected classifications before execution: completed
Job and replaced failed pod → historical; crash loop → attention now; missing owner,
incomplete collection and stale snapshot → insufficient evidence. Expectations were
excluded from model context. Live candidates were deterministic: failed pods first,
then other unready/unknown-state pods, then ready pods with restart history; ten
selected with explicit omitted count. Names stayed in the local private lookup.

## Results and evidence

An initial live CLI attempt collected complete source evidence, but used the absent
default auth store. Triage `111ac424-6f5c-4654-b6e3-39acbce92208` recorded
`provider_error` before a logical model step. The documented existing external
subscription store was then selected explicitly; no credentials were copied.

### Initial prompt and correction

The v1 fixture batch `be5c9cb8-9cf9-4753-8f7d-38f6c065deb8` produced six matching
final labels. Five used one model step; the stale fixture used two. Assistant review
found its final stale-case explanation incorrect: it questioned Job recovery instead
of identifying the stale source. Label agreement alone therefore overstated quality.
The original run did not retain semantic rejection codes, so its first rejected
answer cannot be reconstructed from saved metadata.

Prompt/context version `workload-triage-v2` adds host-calculated freshness/age and
missing-section metadata, with explicit instructions to explain stale evidence.
Semantic result rejections are now checkpointed with safe codes and exported through
the common event schema. Historical v1 records remain readable without relabeling.

### Revised prompt fixture batch

Batch `5934026d-3a84-4557-b10f-4e06a750b041` used v2 and matched all six expected
labels in one step each, with no semantic rejection. Assistant review checked each
explanation against supplied facts. The stale explanation now explicitly cites the
3,600-second source age and 900-second limit; incomplete access cites failed Job
collection. These are six developer-authored fixtures, not an independent accuracy
estimate or proof of reliability on other clusters.

| Fixture | Run | Final classification |
| --- | --- | --- |
| Completed Job | `8698ece4-28ca-4716-b67b-81e970d9f562` | historical |
| Replaced failed pod | `cf826dd8-2777-4e7e-a9d8-a583b432efa2` | historical |
| Crash loop | `82890b60-6faf-416a-9412-ae59e9ec0ff9` | attention_now |
| Missing owner | `1af5fa5d-f800-46ad-b71e-c06514fc3935` | insufficient_evidence |
| Incomplete collection | `8e906b9e-6c8f-4adc-8330-b1dcc535e4e8` | insufficient_evidence |
| Stale snapshot | `e2c1d93e-401f-4ea9-a512-c82b761076fc` | insufficient_evidence |

### Live source and transport trials

The first authenticated CLI triage `0617755f-e019-44fe-86a7-e6593923e309` completed
using v1: 16 eligible pods, ten selected, six omitted. It returned five historical
restart findings and five insufficient-evidence findings, including all three Failed
pods. Their controllers were outside the first adapter's supported owner kinds;
neither age nor old termination timestamps cleared them. No attention_now finding
was established in the selected sample. This is not a cluster-wide all-clear.

An actual external MCP client exercised the compiled stdio application, discovered
five tools, invoked a configured investigation and composed a five-source brief.
The v1 MCP investigation job `6f22e006-04ac-4c15-99b2-d4b8e45d98f8` produced triage
`187cf218-377d-4d3c-a827-5f1bf01b74f5` and brief job
`76acb8a6-1b63-47f4-a210-8b52c548c03d`. Its first assessment was rejected with
`RECOVERY_NOT_ESTABLISHED`; the second completed with the same five/five distribution.
The rejection was retained, not counted as first-pass success.

The first attempt to restart the compiled host failed before admission because the
stdio SDK did not call the host's close handler on stdin EOF, leaving its lock.
After verifying no host process remained, the stale empty lock was removed. The
host now handles EOF explicitly; a compiled transport regression verifies lock
release and successful restart/inspection. Crash locks still require operator checks.

The final v2 MCP investigation `87083d52-a392-4286-8e0f-00be45ef25c7` collected
source `093b0238-f46d-4890-b0df-bceca224820b` at 2026-09-20T02:12:39.751Z and
produced triage `a9e85428-c8eb-45bf-8d4e-f7a88b695245`. It again needed two steps:
one `RECOVERY_NOT_ESTABLISHED` rejection, then five historical and five insufficient
findings. The validator prevented an unsupported recovery claim from reaching the
brief. Assistant inspection found the final reasons grounded in supplied facts.
Reported usage was 14,354 input and 4,047 output tokens for this live assessment.

Final brief job `f5d18a15-8e6a-41ad-83f7-8b968c7c1a84` (brief run
`a4fd98c0-87e4-4b47-b7ff-5c6543c9d506`) combined refreshed TrueNAS, both compute
inventories, k3s/Argo counts and the triage Attention section. Snapshot freshness
and the second host's missing Docker/Podman coverage remain explicit. The real
client disconnected cleanly and the host released its lock.

### Software verification

Tests cover input/command boundaries, privacy, UID/namespace matching, selection
omissions, future/stale evidence, missing coverage, current-generation recovery,
invented citations, bounded correction, cancellation, storage failure before another
model step, admission races/budgets, provenance, symlink rejection and actual compiled
stdio shutdown/restart. The existing OSS release continues to exclude these homelab
packages and applications. An initial full-suite check caught a catalog-order change;
appending the new capability preserved the previous discovery ordering.

Final `npm run verify` passed with pinned Node/Go integration fixtures and the fresh
portable-release install enabled: **244 passed, zero failed, zero skipped**. Package
boundaries, documentation, generated manifests/events and typechecking also passed.

## Limitations and next step

The owner lookup supports Jobs, ReplicaSets and Deployments. StatefulSet, DaemonSet
and custom-controller recovery remain unqualified; these limits produced useful
uncertainty in the actual trial. Projection loses unrecognized reason details by
design. Pod age is not failure age, restart totals are cumulative, and reads are
not atomic. Controller readiness is not application-level health. Six omitted
candidates in these live samples received no assessment.

No repairs, logs, event messages, arbitrary shell commands, new credentials, server
RBAC configuration or remote service changes occurred. Model output contains semantic
judgments; validation and fixture agreement do not prove prose accuracy. Provider
usage is reported in saved runs; monetary cost and subscription quota remain unknown.

The next evidence-driven expansion is a separate read-only contract for the custom
owners behind the failed pods, then StatefulSet/DaemonSet status if useful. Do not
silently widen the existing collector into generic kubectl, logs or repair.

## References

- Plan: [evaluation phase 23](../evaluations.md#phase-23--workload-triage-qualification).
- Context: [package design](../../design/packages-and-recipes.md).
- Contract: [workload triage](../../specs/workload-triage.md), [brief](../../specs/homelab-brief.md).
- Rationale: [ADR-0026](../../adr/0026-triage-workload-findings-through-bounded-evidence.md).
