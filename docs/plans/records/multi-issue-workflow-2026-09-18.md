# Evaluation record: Bounded multi-issue workflow — 2026-09-18

Historical evidence appendix to [the evaluation plan](../evaluations.md). This
completes [backlog Phase 4](../backlog.md#phase-4--bounded-multi-issue-recipe).
Review was software verification and assistant integration review, not independent
assessment-quality acceptance.

## Method and boundaries

Freeze public issue snapshots from the previous relevance trial in this order:
`get-bb/bb#3886`, `#3337`, `#3558`. Body lengths are 7,421, 8,610, and 3,509 characters.
The expected operational outcome is two completed child runs and a third item
explicitly `not_attempted: budget_exhausted` under a shared allowance of two.
Do not automatically retry, silently truncate inputs, or treat a partial workflow
as a successful assessment of every issue.

Codex CLI 0.153.0 used `gpt-5.6-terra` on the signed-in ChatGPT subscription. The
MCP server used SDK 1.30.0 and Copilot `gpt-5.6-terra` with unchanged AgentLayer
0.0.36, readiness prompt `bug-readiness-v4`, input v1 and assessment/run v2. The
new workflow is v1. The consumer proof allows 360 seconds overall, a 150-second
MCP tool timeout, and two inner-agent invocations retaining three logical steps
and 60 seconds each. These are invocation/deadline bounds, not monetary quotas.

The trial invoked no code-location agent and made no GitHub changes. Source data
was already local; no fresh intake or maintainer grading was needed.

## Results and evidence

Both consumer attempts remain in ignored `runs/mcp-proof/` artifacts:

| Attempt | Finding |
| --- | --- |
| `badd53f1-7e1e-43c9-8c35-6d2236a2f743` | Workflow execution and budget handling completed, but Codex supplied **empty bodies for all three issues** when copying snapshots into `assess_issues`. Exact-input verification correctly rejected the proof. Two inner runs consumed capacity. Their judgments do not assess the frozen reports. |
| `b20de776-d3ac-49cc-b288-acdd7a17ed16` | After changing the handoff to immutable host-prepared input, Codex discovered its hash, invoked `assess_prepared_issues`, and inspected the workflow. Exact inputs, results, events, and consumer output matched. |

The failed copying attempt produced `needs_information` for #3886 and
`feature_request` for #3337 from their titles and empty bodies. These are preserved
as outputs on corrupted inputs, not relabeled or included as judgments on the
original reports. This is a practical reason to pass artifact identities through
orchestration rather than require models to reproduce large input payloads.

The successful workflow was `076b0c5a-81a7-4aa5-a13a-58f63fc9f6dd`, started
`2026-09-18T23:37:39.307Z`, finished `2026-09-18T23:37:52.285Z`:

| Issue | Item outcome | Child run |
| --- | --- | --- |
| #3886 | Completed; `bug_report` / `ready` | `89b3353e-52c3-4842-81b2-556721c251b2` |
| #3337 | Completed; `bug_report` / `ready` | `7b0fe203-5530-464b-876a-befdd090592b` |
| #3558 | Not attempted; `budget_exhausted` | None |

The parent ended `partial`, with limit 2, consumed 2, remaining 0. All three full
snapshots were preserved in order. Eighteen common events correlate the parent,
reservations, exact child identities, and skipped item. The consumer's final JSON
reported the partial outcome and null child ID for #3558. No model assessed #3558
in either attempt. Four inner assessments occurred across both separately
recorded attempts; the first two are excluded from the successful proof.

Software tests cover atomic reservation, shared capacity across singles and
workflows, retry exhaustion, competing calls, malformed/duplicate input,
pre-admission and mid-workflow cancellation, cancelled initialization, failed
initialization/inference, persistence failures at admission/reservation/child/final
boundaries, exact prepared inputs, mutation protection, unknown usage, and
historical event compatibility. **86 tests pass**, plus types, documentation,
manifest drift, and the credential-free demo. Saved proof verification requires no
model calls. These checks establish integration properties, not task accuracy.

## Limitations and next step

The budget belongs to one process and resets on restart. The workflow is
sequential, stores snapshots, and does not resume after interruption. It does not
supply durable cross-process quota enforcement, token/cost caps, or provider retry
accounting. Child usage remains provider-reported; absent values stay unknown,
and outer Codex inference usage remains separate.

Prepared input is optional and fixed at launch. Direct snapshot submission still
accepts caller-provided text, including empty bodies as allowed by the existing
issue contract. A consumer must validate that those are its intended inputs;
the agent cannot reconstruct omitted facts. Host-prepared input solves fidelity,
not prompt injection or task-quality qualification.

A next recipe can add code-location for selected ready outcomes, but first define
host-owned source acquisition, pinned revision and parent identity, and how its
admission draws from the same allowance. No universal coordinator is required.

## References

- Plan phase: [evaluation plan — Phase 6](../evaluations.md#phase-6--bounded-multi-issue-consumer).
- Rationale: [ADR-0007](../../adr/0007-bound-a-multi-issue-readiness-workflow.md).
- Context: [composition](../../design/composable-agents.md),
  [validation](../../design/validation.md).
- Contracts: [readiness workflow](../../specs/readiness-workflow.md),
  [MCP](../../specs/mcp-adapter.md), [events](../../specs/agent-discovery.md).
