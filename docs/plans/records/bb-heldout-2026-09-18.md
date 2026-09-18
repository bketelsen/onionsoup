# Terra/Luna held-out issue evaluation — 2026-09-18

This batch evaluates the existing bug-report readiness agent with
`gpt-5.6-terra` and `gpt-5.6-luna` through Copilot. It uses the same frozen
`bug-readiness-v3` prompt and 40 new issue snapshots for both models. The purpose
is to collect evidence for a cost-conscious supervised pilot. Successful calls
and agreement between models are not human acceptance scores.

## Predeclared protocol

- Batch ID: `2bea7451-dc54-41fe-8e4c-69dfeb365325`.
- Source: open issues from `get-bb/bb`, fetched on 2026-09-18.
- Selection: the latest 300 API entries, excluding PRs and numbers at or above
  3795; 231 eligible snapshots, zero invalid/oversized snapshots rejected.
- Forty cases selected using seeded hash ordering within four text-based buckets
  and round-robin selection. Seed: `heldout-2026-09-18`.
- Final mix: 12 short, 11 feature, 6 intermittent, and 11 detailed reports.
  Buckets are sampling heuristics, not gold labels.
- Issue numbers range from 2130 to 3772, with no overlap with the prior eight-case
  pilot. The cutoff also excludes the newer issues inspected during development.
- Only frozen titles/bodies enter model context; comments and attachments do not.
  Both models receive identical snapshots, alternating which runs first.
- Three steps and 60 seconds maximum per assessment. Failures remain in the
  denominator; no automatic reruns or tuning against batch outcomes.
- Graduation requires all cases completed and reviewed, at least 36/40 accepted
  unchanged, zero false-ready decisions, and a separate human cost decision.
  The minimum sample for future batches is 30 cases.

The manifest records complete snapshots, input hashes, prompt text/version, and
runtime file hashes before execution. These saved cases remain available for
comparison even when fetching GitHub again yields different open issues.

## Corpus limits

Twenty-seven of the forty selected reports declare agent involvement. Authorship
of the other thirteen is unverified. This is evidence about this repository's
current reporting patterns, not a clean sample of human-written OSS reports.
It also includes feature proposals and older reports; it does not simulate the
arrival rate or distribution of a new-issue inbox.

Short/feature/intermittent/detailed strata improve variety without establishing
representativeness. Human reviewers should use the saved snapshot rather than
later comments or repository knowledge when judging adherence to this agent's
input boundary. Project-maintainer feedback remains valuable for deciding
whether that boundary is useful in practice.

## Results

All 80 assessments were attempted. The batch exited nonzero because Luna had one
failed assessment; final reports were still generated, and no retry replaced it.

| Measurement | gpt-5.6-terra | gpt-5.6-luna |
| --- | ---: | ---: |
| Valid completed assessments | 40/40 | 39/40 |
| Failed assessments | 0 | 1 |
| Completed in one step | 36 | 27 |
| Total logical steps | 44 | 55 |
| Median elapsed seconds, all finished runs | 7.16 | 3.15 |
| SDK-reported input tokens | 82,702 | 111,849 |
| SDK-reported output tokens | 9,994 | 15,113 |
| Ready | 15 | 16 |
| Needs information | 4 | 4 |
| Out of scope | 21 | 19 |
| Human-reviewed assessments | 0/40 | 0/40 |

Token totals include correction steps and the failed run. They are not billed
costs or measured subscription quota. Luna used 25% more logical steps and more
reported tokens; a cheaper per-token or quota rate could still outweigh that
overhead. This batch does not measure the cost ratio. It is a single run per
snapshot/model, so it also does not establish repeatability.

The models agree on disposition for 37 of 39 completed pairs (94.9%). Review these
cases first, then inspect the agreement cases as well:

| Issue | Terra | Luna | Review focus |
| --- | --- | --- | --- |
| [#2785](https://github.com/get-bb/bb/issues/2785), cancellation provenance | out_of_scope | ready | Does missing actor/reason metadata describe a defect or request a new capability? |
| [#2795](https://github.com/get-bb/bb/issues/2795), project new-thread pane behavior | out_of_scope | ready | Does the requested pane behavior belong to existing supported behavior or a product change? |
| [#2298](https://github.com/get-bb/bb/issues/2298) | ready | failed | Luna exhausted three attempts: reproduction, expected, then actual quotes failed exact-source validation. |

Luna's #2298 failure is `no_valid_assessment`, with `stopCondition` as the recorded
termination reason. There is no published assessment from that run. The runner
retains the rejected submissions and validation errors for diagnosis. Another
Luna case, #3269, corrected two environment-quote errors on its third attempt.
SDK warnings about skipping unsupported reasoning parts appeared during correction
calls; these are retained in the local progress log and do not themselves establish
why a particular assessment failed.

Human acceptance, false-ready rates, and cost decisions remain unknown. Terra
still needs human review. Luna already misses this batch's zero-failed-runs
criterion, even if all its completed outputs prove useful. Do not loosen the
predeclared gate after seeing that result. Use the failure to guide development,
then assess any changed prompt/runtime on a fresh held-out batch.

## Review and artifacts

Local artifacts are in `runs/bb-heldout-2026-09-18/`: `manifest.json`, original
`records/<model>/<issue>.json`, `summary.json`, `report.md`, and `report.html`.
The HTML report shows each source and both assessments and exports human feedback.
The [workflow guide](../../specs/batch-evaluation.md) explains review, importing feedback,
cost decisions, and interrupted runs. No GitHub comments or labels are changed.

Begin with disagreements, then review all outputs—including cases where both
models agree—to avoid mistaking agreement for correctness. Do not use the current
agent to supply its own acceptance labels. Once failure patterns inform a prompt
change, reserve a fresh batch for the next independent evaluation.

## References

Historical evidence appendix to [the evaluation plan](../evaluations.md).
Results apply to the versions and inputs recorded above; relocation does not
establish current task accuracy or independent maintainer acceptance.

- Context: [validation](../../design/validation.md).
- Contracts: [readiness](../../specs/bug-readiness.md),
  [batch evaluation](../../specs/batch-evaluation.md),
  [inbox](../../specs/inbox.md),
  [code-location](../../specs/code-location.md),
  [packet](../../specs/investigation-packet.md).
