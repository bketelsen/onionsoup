# Bounded test completion and source-linked overviews — 2026-09-18

Code-location now reserves two model steps for test reads and constructs its
overview from validated locations. The model still selects code/tests and writes
the explanations beside quotations, but no longer writes a second, separate
narrative summary. This removes the surface that introduced the previous
unsupported navigation-listener claim; it does not prove the remaining semantic
judgments correct.

The frozen trial completed five of six real runs. Both reload results correctly
distinguished keyboard/menu cleanup from unverified navigation behavior. OAuth
retained a setup-and-assertion pair, the completed focus repeat reached an
assertion, and the previously unused title-generation report found relevant
eligibility/fallback tests. The other focus attempt failed citation validation
and remains a partial packet. A follow-up correction-feedback change and two
explicit new attempts are recorded separately below.

Local artifacts are under `runs/reliability-2026-09-18/`, including the
[packet index](../runs/reliability-2026-09-18/index.md), manifests, source snapshots,
and offline audit. Raw runs remain ignored local data.

## Implementation and compatibility

- **Eight general steps, two test-read steps, two submission/correction steps.**
  Search and code reads are removed in the middle phase. The last phase exposes
  only submission. Early valid submission still ends the run. Total bounds remain
  12 model steps, 12 inspections, 36,000 source characters, and 180 seconds; no
  phase resets the deadline or adds source-call/context capacity.
- **Code-location result version 2.** The host constructs a short overview from
  the first validated code path/line and test citation count. It rejects altered
  saved overviews and separate model-submitted summaries. Reasons and uncertainties
  remain model judgments and require review. The input handoff and packet envelope
  retain their versions; new nested location runs/briefs use version 2.
- **Historical version 1 remains readable.** Old model summaries are preserved,
  including the known unsupported one. The compatibility check validates 12
  prior packets with byte-identical Markdown and all 12 historical inbox location
  records. Readiness runtime remains unchanged.
- **Indexed correction feedback.** The first real trial revealed several citation
  errors in one submission. Returning only the first error caused serial guessing
  and exhausted correction attempts. The follow-up validator collects detected
  range, symbol, path-kind, and quote-size errors for every pointer in one compact
  response. It still rejects the whole invalid draft and keeps the same budget.

The test-read phase trades some general exploration for finishing an existing
lead. It does not guarantee an assertion will be found; an exhausted source
budget or missing candidate can still produce a limited result.

## Frozen trial and evidence

Provider/model: Copilot `gpt-5.6-terra`; prompt: `code-location-v6`.
All real cases use pinned `get-bb/bb` commit
`3a4288bd0f34f888a5eb43f1099f7b60fe86eea4` and exactly reused readiness records.
The selected cases were #3337, #3558 twice, #3892 twice, and #3886. The last was
the remaining unused report in the earlier frozen ranking; it had previously
been assessed for readiness, but not used to tune code-location. The others
are development regressions, not independent evaluation examples.

The first frozen runtime was
`c74a034283e4dcc2e07986495ff848b381de712c3f74ed4036075e174f5a1511`.
The correction-feedback follow-up keeps the same prompt and uses runtime
`51e2922bceae9c8f56ab8cdc215e51d11301cf379ec3f6cf0471c48341b5b361`.
The initial manifest and failed run were not overwritten. Source snapshots for
both runtimes are saved locally with hashes verified against those identities.

All six live synthetic cases passed expected implementation and quoted-assertion
checks: sparse prose, misleading paths/placeholders, embedded instructions,
focus versus lifecycle behavior, a distant fixture consumer, and keyboard reload
versus navigation. The new event-path case's explanation explicitly distinguishes
the keyboard handler from renderer navigation. Expectations remain outside model
context and no fixture source/tests are executed. This is development evidence,
not a statistical accuracy score.

`npm run verify` passes 56 software tests. New checks cover phase-specific tools,
early submission, continuous step indices and summed usage, canonical v2 summaries,
historical v1 preservation, and reporting multiple indexed citation errors in one
response. The credential-free AgentLayer demo also passes.

## Assistant review of real reports

| Report | Result | Evidence and limits |
| --- | --- | --- |
| #3337 OAuth expiry | Completed | Reads the emitted authentication-error setup and the recovery/session assertions. The brief distinguishes bridge recovery from UI sign-in/title behavior. |
| #3558 focus, first attempt | **Partial: no valid brief** | Found focus notification behavior, but submitted overlong citations and symbols absent from quoted ranges. Corrected errors serially and exhausted the budget. There is no accepted brief; the raw source and failed submissions remain inspectable. |
| #3558 focus, repeat | Completed | Reads the explicit `webContents.focus()` helper and controlled-target focus/show/restore assertions. The plugin-to-helper connection and cross-session UI effects remain unverified. |
| #3892 reload, both attempts | Completed | Both select the keyboard handler, manager hide operation, and window-specific visibility assertions. Their explanations say navigation-event dispatch was not established. Neither repeats the old claim that a navigation listener was found. |
| #3886 command-first title, new | Completed | Finds title eligibility and `too-short` handling, plus word-boundary and fallback assertions. Notes that tests use empty mentions and do not establish command-mention behavior or the broader provisioning/UI path. |

This review inspected source and assertions without reproducing symptoms or
running the target project. It is assistant development review, not maintainer
acceptance. Both selected repeats are only one additional sample each; they do
not establish stable behavior across reports or model runs.

The initial six real runs yielded 17 accepted citations and 28 inspected excerpts,
all matching pinned Git blobs, including excerpts retained from the failed run.
The six synthetic runs add 13 exact citations and 14 excerpts. Citation accuracy
remains distinct from relevance and correctness of a model's explanation.

## Correction-feedback follow-up

Two fresh #3558 attempts reuse the exact original parent/input and source commit
under the second runtime. The correction change only makes validation feedback
more actionable; it does not expand the agent's task or relax citation rules.
Their outcomes and audit are recorded in `correction-summary.json` and
`audit.json` under the local trial directory.

Both completed, in 9 and 12 model steps respectively. The first corrected one
overlong test citation, but selected a Cmd-L keyboard-focus assertion rather than
hidden automation behavior; its relevance is weaker despite explicit caveats.
The second initially received three indexed range errors together, corrected
the code ranges, then corrected the remaining test range and submitted a valid
hidden-tab creation assertion (`visible === false`, zero focus calls). It still
does not cover subsequent controller activity or cross-session UI effects.

The follow-up adds six exact citations and ten excerpts. Across all eight real
attempts, seven completed and one remains partial; all 23 accepted citations and
38 excerpts match pinned source. All eight packets regenerate identical Markdown.
These are two fresh model attempts, so their completion cannot by itself establish
the size of an improvement from the feedback change. The unit regression directly
establishes that all invalid pointer fields are now reported together.

The remaining quality problem is choosing the most relevant behavior, not merely
finding an assertion or producing a valid brief. The next bounded experiment
should make the distinction between a directly relevant assertion, an adjacent
behavior test, and an unfinished lead explicit in the result. It should avoid
claiming that a lexical `expect` check can decide semantic coverage. More agents
or a larger coordinator are not needed to investigate that boundary.
