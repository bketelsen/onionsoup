# Evaluation record: Shared bug and feature proposals — 2026-09-18

Historical evidence appendix to [the evaluation plan](../evaluations.md).
This records [change-workflow Phase 1](../investigation-to-pr.md#phase-1--read-only-change-proposals):
scripted reliability checks and assistant review, not independent maintainer acceptance.

## Method and boundaries

Copilot / `gpt-5.6-terra`, requirements prompt v1 and proposal prompts v1–v3.
All inputs and attempts were retained privately. New code reads Git blobs and
produces proposals; it does not run target tests, modify target code, or publish.
The recipe's shared limit is two agent invocations, three steps per agent, 90
seconds per agent and 240 seconds overall. Parent investigation usage is historical.

Real inputs were get-bb/bb #3926 (a saved ready-bug packet) and a fresh #3912
feature snapshot obtained from the console's saved brief selection. Source pin:
`3a4288bd0f34f888a5eb43f1099f7b60fe86eea4`. #3912 retained
`feature_request / not_applicable`; the bug-only locator was never invoked for it.

Three additional operator-authored fixtures exercised a clear additive JSON
export, ambiguous export requirements, and a mixed archived-list behavior change
plus export. Their tiny `example/widget` Git fixture contains a complete list
function and is explicitly synthetic, not an inspected public repository. Its
readiness classification was scripted fixture setup; requirements and proposals
were live Terra calls. Expectations before execution: clear additive scope should
be reviewable; ambiguous and mixed requests should ask blocking questions; the real
bug should preserve its unresolved root-precedence contract. Unknown cost semantics,
compatibility and irrelevant source evidence should remain visible for #3912.

## Results and evidence

All 11 proposal workflows completed structurally: 20 live proposal/requirements
invocations plus one separate live readiness invocation for #3912. This is a small
prompt-development exercise on five cases, not 11 independent tasks or an accuracy
benchmark. Every attempt is listed below; none was discarded or overwritten.

| Case | Proposal prompt | Result | Workflow UUID |
| --- | --- | --- | --- |
| Real bug #3926 | v1 | needs_information | `20975d57-fd5f-4b20-91b3-91499bc4c662` |
| Real feature #3912, query `cost` | v1 | proposal_ready; assistant found inadequate source grounding | `2e62d3fe-6d3e-4f18-8b34-2b579fbea831` |
| Clear synthetic feature | v1 | proposal_ready | `5960d675-e074-4c7d-be27-206fd0c9a44b` |
| Ambiguous synthetic feature | v1 | needs_information | `5a79e329-4a21-4a3a-8763-d1b42232c876` |
| Mixed synthetic request | v1 | needs_information | `c7a33633-464b-4015-9f10-059020dcdf75` |
| Real feature #3912, query `addTokenUsage` | v2 | needs_information | `7f565976-c14f-421e-9cb8-8d29cb81cc8d` |
| Real feature #3912, query `cost` | v2 | needs_information | `4e49aa4a-a24c-498b-9e72-ed209b70bfd2` |
| Clear synthetic feature | v2 | needs_information; overly conservative about entry-point/docs evidence | `c50d0a12-9744-4612-a218-85a00f6f6e4a` |
| Clear synthetic feature | v3 | proposal_ready | `bbd47397-06c9-41fd-9c7c-ba9fbc47332b` |
| Real feature #3912, query `cost` | v3 | needs_information | `9813f418-31f2-4613-92c0-2213a934b99b` |
| Real bug #3926 | v3 | needs_information | `47a273ce-f91f-46e5-8042-91c5f52b9619` |

The initial broad literal found accessibility and CI files. Prompt v1 still
returned ready scope supported principally by issue text, and inaccurately said
source context was not inspected despite having irrelevant excerpts. This was a
quality failure, even though the result passed the original structural contract.
V2 required relevant source support in scope/checks and explicitly treated unrelated
matches as insufficient. It corrected that case but blocked the clear fixture over
unconfirmed package/documentation locations. V3 distinguishes blocking behavior
choices from advisory implementation details and asks the model to assess excerpt
relevance itself. The host additionally checks source references in ready scope or
verification. That mechanical check cannot establish semantic relevance.

Assistant review of the final examples:

- Clear feature: four criteria cover ordered name-only JSON, empty input, unchanged
  list output, and documentation. Checks map to acceptance, compatibility and docs;
  no execution is claimed and no scope is accepted by the host.
- Real feature: useful scope/checks are drafted, but irrelevant source remains a
  blocking evidence gap. The more specific v2 query found protocol docs and SDK
  exports, still short of the concrete bridges/API/UI implementation. A literal
  search is not a reliable feature-location capability.
- Real bug: preserves the declared-versus-resolved root precedence decision and
  requests the downstream scan consumer before choosing a repair location. Its
  regression plan remains proposed, with adjacent tests not promoted to proven coverage.
- Ambiguous/mixed cases: requirements and proposal both retained blocking choices
  about format/interface/fields or scope splitting and archived-task compatibility.
  These cases were not rerun on v3; current software enforces that unresolved
  requirements cannot produce a ready proposal, but semantic repeat stability is unknown.

All 27 stored source citations across attempts were independently compared with
Git blobs at their recorded pins and matched exactly. This establishes quotation
integrity, not diagnosis, relevance or acceptance. Proposal workflow durations were
12.8–25.5 seconds. The 20 child agents reported 45,674 input and 19,757 output tokens;
these exclude fresh readiness and historical parents. Billed cost and quota consumed
are unknown.

Console HTTP checks exercised feature investigation, proposal submission, exact
parent binding, artifact retrieval and duplicate reuse with no extra inference.
The first HTTP probe raced service startup and was connection-refused before action
admission; rerunning after the listener was available succeeded. No visual browser
qualification was performed. Private operator IDs:

- Feature investigation: `fd674eec-95d1-44e4-9ed9-5a8dd8fa603c`.
- Initial feature proposal: `67180553-f80b-4ddc-9bf6-2126703c1597`.
- Focused feature proposal: `49c72b61-ffd0-4f82-a629-f8c24cdbaed5`.

Raw records live under ignored `runs/change-proposals/p10-2026-09-18/` and local
console operation directories. Historical prompt literals and validation remain
readable; older results were not relabeled. Automated checks cover evidence/criterion
invariants, sparse and mixed outcomes, admission/storage failure, provider failure,
cancellation, actual Git origin/pin checks, bounded source reads, historical versions,
escaping, stale parent rejection, deduplication, discovery and event privacy.
`npm run verify` passed documentation/capability checks, TypeScript, and all 159 tests.

## Limitations and next step

The shared read-only stage is implemented and useful for exposing scope decisions.
It is not qualified for autonomous implementation. Requirements varied across
repeats of #3912, including whether token display or provider accumulation semantics
needed clarification. Judgments about relevance, invented requirements and whether
a question should block remain model-dependent. No independent human acceptance,
reviewer calibration or model comparison was performed.

Next: retain this boundary and design the isolated baseline runner on an
operator-owned fixture with one bug and one feature. Separately improve feature
source selection only as needed; likely explicit source paths or bounded follow-up
reads, not a broader monolithic agent. Pin accepted scope before patch generation.

## References

- Plan phase: [evaluation Phase 12](../evaluations.md#phase-12--shared-bug-and-feature-proposals), [change workflow Phase 1](../investigation-to-pr.md#phase-1--read-only-change-proposals).
- Context: [validation](../../design/validation.md), [change workflow](../../design/investigation-to-pr.md).
- Contract: [change proposals](../../specs/change-proposal.md), [operator console](../../specs/operator-console.md).
- Rationale: [ADR-0014](../../adr/0014-draft-read-only-proposals-from-frozen-evidence.md).
