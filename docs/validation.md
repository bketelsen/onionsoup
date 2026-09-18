# Validation record

The [portable-packet pilot](packet-pilot-2026-09-18.md) demonstrates a second
consumer without inbox state: five primary packets and two location repeats all
completed. Four primary reports were location-eligible; a fresh readiness run
returned needs-information for the fifth. All six location runs completed with
21 exact source citations. Repeated test selection regressed on browser focus,
and OAuth selection stopped at a fixture. These quality limits are separate from
the 49 passing software checks and the offline artifact/source audit.

The [search/test-selection follow-up](code-location-search-2026-09-18.md) improved
the latest three code-location briefs to include actual test assertions. V4
completed all three, retained 13 exact source citations, and passed three small
synthetic search/injection checks. One intermediate v3 step-exhaustion failure
is preserved. Semantic selection still varies, especially within the ACP catalog;
the report separates those limits from the 42 passing software checks.

The [code-location pilot](code-location-pilot-2026-09-18.md) adds a second narrow
agent and an explicit readiness-to-source handoff. Two Terra passes over three
reports produced six grounded briefs; all 23 citations match the pinned source.
Search quality was mixed, including a relevance regression in the second pass.
The pilot records that limitation separately from contract/runtime success.

A separately requested [eight-case local-server experiment](local-server-evaluation-2026-09-18.md)
completed 8/8 with the same v4 contract and matched Terra's final classifications,
but needed 15 logical steps versus Terra's 10 and exposed a weaker missing-information
assessment. This did not change the Terra-only production/evaluation defaults.

The [read-only intake pilot](inbox-pilot-2026-09-18.md) exercised 17 live Terra
assessments and a normal repeat that skipped all 17 without another model call.
It also adds tested intake/recovery bounds and an [interactive local inbox](inbox.md).
These are operational results; human quality gates remain unchanged.

Current contract v2 separates request kind from bug readiness; prompt v4 emits
explicit feature/support/other/unclear classifications without project acceptance
decisions. Development evaluations and new issue batches now use Terra only.
Historical model comparisons below retain their original contracts and results.

On 2026-09-18, Copilot Terra with `bug-readiness-v4` passed **12/12** development
cases, with zero false-ready outcomes against the expected labels. Eleven cases
completed in one step; the commit-as-version case needed two. The new support,
unrelated, and unclear cases all returned their explicit kinds with
`not_applicable`. Inspection of the returned summaries and questions found neutral
request descriptions and questions directed at missing report details. These are
synthetic development checks, not independent human acceptance measurements.
Records are under `runs/terra-contract-v2-2026-09-18/`, with the evaluator log at
`runs/terra-contract-v2-2026-09-18.log`.

The [40-issue held-out Terra/Luna batch](bb-heldout-2026-09-18.md) adds a frozen
evaluation set and a [local human-feedback workflow](batch-evaluation.md).
Its technical results do not establish correctness; acceptance and false-ready
ratings remain pending until a human reviews the assessments.

Brian's six v1 reviews were subsequently imported: three accepted assessments per
model. The remaining 74 assessments are unreviewed, so overall acceptance remains
unknown. These reviews concern the old contract and are not transferred to v2.

The subsequent [Terra comparison](terra-comparison-2026-09-18.md) used the same
v3 prompt and snapshots: Terra passed 9/9 synthetic cases, matching Sol, versus
7/9 for mini. Measured Terra/Sol latency ordering differed between the synthetic
corpus and three shared difficult real reports; no consistent speed advantage
was established.

The earlier [real-issue pilot on get-bb/bb](bb-pilot-2026-09-18.md) found judgment
failures beyond the initial synthetic corpus. That pilot used prompt v3 and
expanded the development corpus to nine cases. The current v4 corpus has twelve
cases. The v2 results below are historical, not a qualification
of the current mini-model setup.

Validation uses the published AgentLayer `0.0.36` packages, not the current GitHub
main branch. Source inspection used revision
`4ad4745a6bf53654a7ced933a0121f3c106bfc9f`; the package differs, including the absence
of the newer automatic-compaction configuration. AI SDK and Zod are aligned to
the published core's versions to avoid incompatible copies of their types.

## Software checks

`npm run verify` typechecks the implementation and runs scripted tests through the
actual AgentLayer loop. Tests cover successful submission, evidence correction,
retry exhaustion, malformed results, cancellation, provider failure, input bounds,
admission persistence failure, contradictory evidence, non-bug classification,
model discovery, and explicit provider selection. These establish contract and
runtime behavior, not LLM accuracy.

Batch checks additionally cover deterministic selection, frozen runtime/input
validation, exclusive execution, preserved interrupted records, feedback identity
and revision history, graduation criteria, safe HTML rendering, v1 record/feedback
compatibility, incompatible kind/readiness rejection, and Terra-only evaluation
execution. A browser smoke check exercised feedback export and reloading without JavaScript errors.

The skill-creator validator checks all four skills. `npm run demo` exercises the
CLI and local artifact write using a scripted response.

## Live model evaluation

The synthetic corpus is [evals/cases.json](../evals/cases.json). Its original six cases covered
a complete prose report, sparse report, blank template, feature request, instruction
injection, and ambiguous reproduction steps. The current evaluator checks kind,
bug readiness, and the exact set of missing fields; evidence grounding is checked by the executor.

On 2026-09-18, Copilot model `gpt-5.4-mini` with prompt `bug-readiness-v1` passed 4/6
cases and made zero false-ready decisions. Two runs exhausted their correction
budget on duplicated or contradictory fields. Prompt v2 clarifies that each field
must appear exactly once across evidence/questions, and that an alleged crash is
actual behavior even without a specific error message. The original validation
boundary was retained.

Prompt `bug-readiness-v2` passed 6/6 cases with zero false-ready decisions on the
same Copilot model. Final questions were manually inspected: they asked for the
missing information without inventing versions or errors. The sparse case needed
two steps and the injection case needed three, so correction overhead remains a
useful target for future improvement. The other four cases completed in one step.

| Case | Result | Logical steps | Local run ID |
| --- | --- | --- | --- |
| complete-prose | ready | 1 | `28ef924f-7ece-4de0-9fc6-45f466292a39` |
| sparse-bug | needs_information | 2 | `843a5db1-4d4c-4b76-a8b1-02f8b23a780d` |
| template-placeholders | needs_information | 1 | `07d75722-84bf-4373-90ae-d840f2fa3465` |
| feature-request | out_of_scope | 1 | `f1c86da9-5ba9-48b1-a28b-4455ed0ef1af` |
| instruction-injection | needs_information | 3 | `a97dcce9-2c9a-4398-8aa4-6a88f479d701` |
| ambiguous-steps | needs_information | 1 | `7948670f-43aa-4a7e-811a-00e444d6dfba` |

Raw local runs are saved under ignored `runs/`; expected answers never enter the
model context. Codex is wired through AgentLayer but has not been live-qualified.

## Limits of the evidence

Six synthetic examples are a development corpus, not a held-out accuracy estimate.
The prompt was improved using failures in this corpus. Passing it would justify a
supervised pilot, not autonomous replies or broad OSS maintenance. Before expanding
scope, assess real new issues, have a maintainer judge false-ready outcomes and
question usefulness, and reserve separate cases for evaluation.

Model catalog discovery projects only enabled entries explicitly advertising tool
calls and streaming. This avoids an observed failure in AgentLayer's strict catalog
schema on unrelated newer entries; it does not guarantee every listed model works
with the adapter. An actual live run is the compatibility check.
