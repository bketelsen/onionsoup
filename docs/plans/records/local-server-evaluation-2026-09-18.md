# Local server assessment — 2026-09-18

**Assessment: promising for this narrow task, with useful final answers, but more
contract-repair work and some weaker wording than Terra.** The local server
completed all eight cases under the existing three-step/60-second limits. My
inspection found no obvious false-ready decision among the four ready results.
The missing-information result needs revision, and two summaries could preserve
source uncertainty more carefully. This is assistant inspection, not human
acceptance or a production qualification.

## Setup

- User-supplied endpoint: a private LAN host on port 8731, using `/v1`.
- Advertised model ID: `halogen-qwen3.8-flash-next`, returned by `/v1/models`.
- Adapter: installed `@ai-sdk/openai@3.0.65`, streaming chat completions with tool
  calls, through the same AgentLayer triage function as the production inbox.
- Prompt: unchanged `bug-readiness-v4`; assessment contract v2; three logical
  steps and a 60-second deadline per issue. Sampling settings were left at the
  server's defaults. We did not independently verify weights, quantization,
  hardware, context limits, or server decoding settings.
- Eight saved public `get-bb/bb` snapshots, selected before local outputs: three
  feature requests, one incomplete bug report, and four detailed bug reports.
  Two of the detailed reports had needed correction steps with Terra.
- Terra references are the already-saved v4 inbox assessments of the identical
  input hashes. There were no new Terra calls, no Luna calls, and no GitHub writes.

This was a requested, isolated local experiment. The regular evaluation commands
and production inbox remain Terra-only. No general comparison harness or new
production provider was added.

## Runtime results

| Measurement | Local server | Saved Terra reference |
| --- | ---: | ---: |
| Valid completed assessments | 8/8 | 8/8 |
| Completed on the first step | 3/8 | 6/8 |
| Total logical steps | 15 | 10 |
| Median elapsed seconds | 14.01 | 4.56 |
| SDK-reported input tokens | 41,611 | 20,682 |
| SDK-reported output tokens | 5,988 | 2,707 |

All eight final request-kind/readiness pairs match Terra: three feature requests,
one bug needing information, and four ready bug reports. Agreement is not ground
truth. Every final evidence quote passed the exact-source check; that check alone
does not establish relevance or completeness.

Token totals include correction attempts. Tokenizers and accounting differ across
providers, and these counts are not a like-for-like bill. Local energy/hardware
cost and subscription quota impact were not measured. The runs were not
simultaneous or repeated, so latency comparisons are descriptive only.

## Source-level inspection

| Issue | Final local result | Steps local / Terra | My inspection |
| --- | --- | ---: | --- |
| [#3912](https://github.com/get-bb/bb/issues/3912), per-thread cost display | feature_request / not_applicable | 1 / 1 | Useful neutral description of the desired new capability. No implied denial. |
| [#3911](https://github.com/get-bb/bb/issues/3911), local llama-server initialization | bug_report / needs_information | 3 / 1 | Needs revision: muddles environment and reproduction, and states suspected causation too strongly. |
| [#3773](https://github.com/get-bb/bb/issues/3773), npm ENOENT provisioning failure | bug_report / ready | 2 / 1 | Investigable report recognized correctly. The source labels its root cause as a hypothesis; the summary should retain that qualification. Environment evidence could include explicit OS/platform details. |
| [#3904](https://github.com/get-bb/bb/issues/3904), plugin directory-switch API | feature_request / not_applicable | 2 / 1 | Correctly treats the unsupported operation as a feature request despite its HTTP 400 error. This was a useful boundary case. |
| [#3072](https://github.com/get-bb/bb/issues/3072), task metadata | feature_request / not_applicable | 1 / 1 | Clear, faithful description of the new metadata capability. |
| [#3899](https://github.com/get-bb/bb/issues/3899), ACP reasoning levels | bug_report / ready | 3 / 1 | Correct existing-integration classification and useful evidence. Summary is more verbose than necessary. |
| [#3607](https://github.com/get-bb/bb/issues/3607), config-directory usage check | bug_report / ready | 1 / 2 | Strong result: quotes the actual three-step setup and the affected version/platform. |
| [#3863](https://github.com/get-bb/bb/issues/3863), repeated SIGTRAP | bug_report / ready | 2 / 2 | Preserves unverified reproduction and avoids demanding a deterministic reproducer. Could clarify that the earlier crash's exact application version is unknown. |

The most concrete quality issue is #3911. It marks `environment` supported using
only the server URL, then asks for Pi/plugin versions inside a `reproduction`
question. It does not explicitly request the affected bb version. The same
question asks for configuration-file contents when a minimal, redacted relevant
configuration would be more focused. Its summary says initialization fails
because the auth handshake fails, while the source presents that as a suspicion.
Terra's saved response asks directly for the missing bb/Pi/plugin versions and
keeps the authentication/timeout explanation qualified as suspected.

For #3863, the local environment quote includes both the release version and
platform, whereas Terra's selected environment quote contains only the platform.
The source itself supplies both. This illustrates why the saved Terra answer is
a reference rather than an unquestioned gold label.

## What the validator caught

There were seven rejected submissions before the eight successful ones:

- Five rejected submissions omitted the required `schemaVersion` field.
- One omitted `summary`.
- One used a non-exact environment quote.
- One exceeded the 800-character quote limit; that submission also omitted
  `schemaVersion`, so these categories overlap.

Five cases needed correction; two used the entire three-step allowance. All
recovered within the existing budget, and no failed result was discarded or
rerun under a new ID. These are observations of this server/adapter configuration,
not proof of an intrinsic limitation of the underlying model weights.

The largest source of correction work is avoidable application metadata. A useful
next engineering experiment would have host code attach the fixed contract
version while retaining strict validation of every model-generated semantic
field. That follows the existing principle that code should own identifiers and
versions. This report does not implement or assume that improvement; it would
need its own validation. Evidence grounding and question quality still require
attention after metadata handling is improved.

## Recommendation and limits

The result supports continuing a **supervised local drafting experiment** for
this task. It does not support dropping validation/correction or automatically
replacing Terra in the inbox. The final classifications were encouraging; the
main observed weaknesses were output-contract compliance, evidence-field
selection on incomplete reports, and causal/uncertainty wording.

Eight purposefully selected, previously seen cases are not a representative
accuracy estimate. They contain no dedicated prompt-injection, support-question,
unclear-intent, or duplicate/stale-input quality challenge. One response per case
does not establish consistency. Human acceptance remains unknown, and none of
these findings were written into a human feedback ledger.

The frozen manifest, exact inputs and baseline IDs, run records, transport status,
reproducible one-off script, evaluator log, and machine-readable summary are under
`runs/local-server-2026-09-18/`. Source and model outputs remain local ignored
artifacts. The production inbox's prompt, provider, records, and runtime files
were unchanged by this experiment.

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
