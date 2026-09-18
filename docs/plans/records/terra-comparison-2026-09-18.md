# Terra comparison, 2026-09-18

Compared Copilot `gpt-5.6-terra` with the saved `gpt-5.4-mini` and `gpt-5.6-sol`
runs from the [bb pilot](bb-pilot-2026-09-18.md). Every comparison uses prompt
`bug-readiness-v3`, the same tool contract, three-step limit, and 60-second abort
signal. No prompt, runtime, or expected-answer changes were made for Terra.

Terra was run on all eight saved real-issue snapshots and all nine synthetic
regression cases. Mini has results for the same complete sets. Sol has all nine
synthetic cases and only three selected real cases. Input hashes were checked
between models. The faster comparison model is the existing `gpt-5.4-mini` run.

## Regression quality and speed

All three models were measured on the same nine synthetic cases, with identical
input hashes and prompt version. Pass requires the expected disposition and exact
set of missing fields, plus successful schema/evidence validation.

| Model | Cases passed | Median run latency | Sum of run latencies | Logical model steps |
| --- | --- | --- | --- | --- |
| GPT-5.4 mini | 7/9 | 1.61 s | 22.25 s | 14 |
| GPT-5.6 Terra | 9/9 | 8.29 s | 72.01 s | 9 |
| GPT-5.6 Sol | 9/9 | 6.59 s | 54.50 s | 9 |

There were zero false-ready dispositions against the synthetic labels for each
model. Mini missed the reproduction question in the injection case and failed to
return a valid result for the unverified-steps case. Terra and Sol completed every
case in one step. Manual inspection of Terra's final questions found focused
requests for the missing fields; its injection-case answer did not follow the
embedded instructions.

Terra matched Sol's measured quality on this corpus, but was about 26% slower by
median latency in these runs. Mini was about five times faster than Terra by this
measure, with the observed quality and retry tradeoff. The real-case comparison
below reverses the Terra/Sol latency ordering, so a consistent speed ranking is
not established. Keep Sol as the current documented supervised-trial choice;
Terra is a credible alternative, not yet a demonstrated latency improvement.

The SDK reported 7,843 input tokens for both Terra and Sol, versus 13,695 for mini
including corrections. Reported output totals were 1,394, 1,419, and 2,064
respectively. These counters are not subscription charges or a cost comparison.

## Real-issue judgments

| Issue | Mini v3 | Terra v3 | Sol v3 |
| --- | --- | --- | --- |
| [#3905: subdirectory diff viewer](https://github.com/get-bb/bb/issues/3905) | ready | ready | Not run |
| [#3904: expose directory-switch API](https://github.com/get-bb/bb/issues/3904) | needs_information | out_of_scope | out_of_scope |
| [#3899: ACP reasoning variants](https://github.com/get-bb/bb/issues/3899) | ready | ready | Not run |
| [#3892: preview survives reload](https://github.com/get-bb/bb/issues/3892) | needs_information | ready | ready |
| [#3886: skill-first thread title](https://github.com/get-bb/bb/issues/3886) | ready | ready | Not run |
| [#3863: Linux SIGTRAP](https://github.com/get-bb/bb/issues/3863) | failed validation | ready | ready |
| [#3849: ACP elicitation](https://github.com/get-bb/bb/issues/3849) | ready | out_of_scope | Not run |
| [#3795: images in question answers](https://github.com/get-bb/bb/issues/3795) | out_of_scope | out_of_scope | Not run |

Terra completed all eight in one step each and agreed with Sol on all three cases
where a direct comparison exists. Its summaries for #3892 and #3863 explicitly
preserve the uncertainty of the candidate reproduction sequences. It recognized
#3904 as a new API request rather than asking for bug-report details.

For #3849, Terra interpreted absent elicitation support as a capability request.
The original pre-run review flagged the feature-versus-interoperability-defect
boundary as ambiguous. This difference is not scored as a correct or incorrect
answer without a maintainer judgment. There is no overall real-issue accuracy
percentage: these are reviewed assessments, not maintainer-labeled ground truth.

On the three real cases shared by all models (#3904, #3892, #3863), observed median
run latency was 5.96 seconds for Terra, 8.43 seconds for Sol, and 8.93 seconds for
mini. Mini's figure includes its failed three-step crash assessment. Terra and
Sol used one step per case; mini used two, three, and three respectively. This
illustrates why the fastest per-call model need not finish difficult tasks faster.

## Interpretation limits

These are single runs, with earlier baseline measurements and no interleaving or
repetition. Provider load, caching, and nondeterminism can affect speed and output.
No explicit reasoning-effort setting was supplied; provider/model defaults apply.
The synthetic cases are a development corpus, including examples derived from
previous failures. Agreement with Sol is useful evidence, not proof of correctness.
All quotes passed exact-text grounding, which does not establish semantic relevance.

No GitHub mutations were performed. No model default, automatic fallback, or
provider selection was changed for this comparison.

## Artifacts

Local ignored directory `runs/bb-pilot-2026-09-18/terra/` contains the eight
`result-<issue>.json` records, `summary.json`, regression results, and full run
records. `provenance.json` records hashes of the prompt, runtime, contracts,
regression corpus, and lockfile used for the trial. The prior `v3/` and `sol/`
directories contain the comparison runs. `comparison.json` contains the verified
nine-case aggregate metrics shown above.

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
