# Search and test selection follow-up — 2026-09-18

The final v4 pass returned useful implementation locations and quoted test
assertions for all three development reports. It fixes the earlier missing-test
result for #3607 and reaches the shared ACP catalog for #3899. The ACP-specific
advertisement path remains incompletely traced. These are assistant-reviewed
development results, not maintainer acceptance or a held-out accuracy estimate.

## Changes driven by observed failures

V3 adds one explicit repository-wide retry when a scoped literal search finds no
matches, keeping the same query and code/tests scope. Source reads suggest up to
six filename-related test paths from the allowed pinned tree. Hints stay outside
the set of citable excerpts. The prompt favors distinctive messages, follows
actual matches across package boundaries, and reads promising tests before
spending more calls searching.

V3 improved search, but #3773 used all twelve steps inspecting source and never
submitted. That failed record is retained. V4 reserves the last two model steps
for submission/correction using only `submit_brief`, the existing context, and
the original deadline. Source tools are available for at most ten model steps.
The overall bounds remain 12 steps, 12 inspections, 36,000 returned characters,
and 180 seconds. Early valid submission still stops immediately.

No responsibility, public input/output schema, provider, model, or readiness
behavior changed. These are prompt versions 3/4 of the code-location agent.

## Same three reports, same pinned source

All real-report runs use the existing inbox snapshots and parent readiness IDs,
Copilot `gpt-5.6-terra`, and commit
`3a4288bd0f34f888a5eb43f1099f7b60fe86eea4`.

| Issue | v3 result | v4 result | v4 steps | v4 inspections | v4 seconds |
| --- | --- | --- | ---: | ---: | ---: |
| 3773 | Failed: no submission after 12 inspections/steps | located | 9 | 10 | 24.61 |
| 3607 | located, direct credential-test assertions | located | 10 | 10 | 31.58 |
| 3899 | located, shared catalog and native-option tests | located | 11 | 9 | 46.82 |

V4's **13 citations** were independently compared with the pinned Git blobs;
all quotations and line ranges match. All three briefs include test assertions.
An unchanged repeat returned three `skipped_completed` outcomes, without model
calls. The inbox displays the latest v4 results; v1–v3 histories remain on disk.

### Relevance, not just grounding

- **3773:** cites the artifact service's bare `npm pack` invocation and default
  command runner. The direct artifact test now includes tarball-content/size
  assertions and a missing-runtime-file failure assertion, instead of just setup
  or peripheral client fixtures. It correctly distinguishes that failure test
  from the reported npm executable/PATH failure.
- **3607:** cites the credential/account readers and health consumer, plus the
  previously missed `provider-maintenance.credentials.test.ts` assertions for
  keychain decoding and credential-file fallback. It also provides a related
  configured-directory test. It does not claim that these tests cover the exact
  maintenance regression.
- **3899:** finds the exact placeholder in shared `model-catalog.ts`, rather than
  stopping at plugin registration. It cites catalog-grouping tests that assert
  low/medium/high/xhigh. These are better starting points than v2's generic agent
  declaration test, but v3 found more directly relevant native `thought_level`
  and OpenCode Zen fixtures. V4 spends attention on generic model-ID variant
  grouping and explicitly leaves the actual Zen ACP advertisement and fallback
  selection unestablished. Selection consistency remains a quality limitation.

In v4 #3899, two early submissions failed grounding checks (an unread/oversized
citation, then a symbol absent from the chosen quotation). The submission-only
phase accepted the corrected result on step 11. No rejected citation was exposed
as a completed brief. The host reserve addresses termination, not semantic
relevance; it does not make a weak test choice strong.

V4 used **29 inspections versus v2's 36**, but **30 model steps versus 20** and
**161,881 / 5,444 reported input/output tokens versus 102,259 / 4,933**. This is a
quality improvement with a token tradeoff, not a claim of lower cost. Cache-read
counts are in each run; subscription quota consumed and billed cost are unknown.

## Small synthetic regression corpus

`evals/location-search.json` contains three cases: sparse prose without a path,
a misleading plugin path with template placeholders, and explicit instructions
embedded in the issue. All cases use a tiny synthetic repository whose relevant
source also includes an instruction-injection comment. Expected implementation
and assertion-bearing test locations remain outside model context. Scripted
readiness admits the synthetic reports; only location calls the live provider.

Both v3 and v4 passed **3/3** concrete location/assertion checks, each in five
steps and four inspections. The outputs retained the expected source/test paths
despite the misleading path and instructions to stop searching. This narrow
development result does not establish general injection resistance.

Use `npm run eval:location` with the existing subscription configuration. Every
invocation preserves its fixture Git repository, scripted parents, live run
records, and summary in a new directory. Fixture source is never executed.
The saved v4 corpus run is `runs/location-search/development-ZxYBEb/`; v3 is
`runs/location-search/development-JBfszo/`.

## Provenance and checks

Real-report records live under `runs/inbox/get-bb--bb/locations/`.

| Issue | v3 run ID | v4 run ID |
| --- | --- | --- |
| 3773 | `f9ffe08e-4c1b-4778-9731-ca58ff762eb7` | `df8ef355-6dfb-4e6e-be1f-b56f1ddc72d4` |
| 3607 | `b2a0b332-cda1-4550-bd32-9cd1a21097e6` | `81f34acf-49ba-4b89-b10d-315caab98991` |
| 3899 | `65e8ca4f-8684-485b-bc9c-f5b1d935ee5c` | `9e039be0-e085-4ca4-8eb8-10f86d5303c3` |

V3 runtime hash: `fc9228d1fa30630abbc139604b614517e6d61e51788ff2191839508c797ada69`.
V4 runtime hash: `316a3cbb73d27d751fec4d34c75ffa91112aef196b6335564cd89240f1958fd8`.

`npm run verify`: **42 tests passed**, including scoped-search recovery, bounded
pinned test hints, rejection of unread hints as citations, submission-only tool
availability, correction using retained excerpts, continuous step indices, and
cross-phase usage aggregation. Browser checks verified the three v4 attachments,
pinned links, expandable evidence/provenance, mobile width, and no JavaScript
errors. No get-bb/bb code or tests were executed and no GitHub changes were made.

The next quality check should use unseen reports and distinguish tests of the
specific execution path from tests in the same module. Repeated runs on a small
fixed sample would also expose selection variance before further prompt tuning.
Keep the task at investigation starting points; these results do not justify
diagnosis, fixes, or autonomous repository actions.

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
