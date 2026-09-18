# Portable investigation packet pilot — 2026-09-18

The same readiness and code-location agents now serve two consumers: the
maintainer inbox and a standalone investigation packet. The packet command
produces deterministic Markdown and self-contained JSON without inbox storage,
configuration, or HTML. It adds no third model-powered agent.

Five primary packets and two repeats completed. Four primary reports reached
code-location; one fresh readiness assessment requested more information and
correctly skipped location. All six location runs completed, and all 21 citations
match the pinned Git blobs. Task quality is mixed: narrow validation/discovery
reports produced useful test pointers, while broader reports exposed weaker
test selection and repeat variance.

Browse the local [packet index](../runs/packet-pilot-2026-09-18/index.md).
Raw artifacts are under ignored `runs/packet-pilot-2026-09-18/`; this document
records the findings even when those local artifacts are not available.

## Selection and frozen execution

- Repository: `get-bb/bb`, pinned at
  `3a4288bd0f34f888a5eb43f1099f7b60fe86eea4`; source/tests were read, never executed.
- Copilot subscription, `gpt-5.6-terra`, `bug-readiness-v4`, `code-location-v4`.
- Exclude all reports used in earlier location trials: #3773, #3607, #3899.
  Rank the remaining observed-ready reports by SHA-256 of
  `packet-portability-2026-09-18:ISSUE_NUMBER`, then choose the first five:
  #3863, #3870, #3558, #2602, #3337. The manifest retains the eligible order,
  input hashes, parent IDs, commit, and runtime hashes.
- Run fresh readiness for the first report; explicitly reuse matching completed
  readiness records for the other four. Repeats reuse their primary packet's
  identical readiness record and location input.
- The first fresh assessment changed #3863 from ready to needs-information.
  Preserve that outcome. Before the other location results arrived, record the
  repeat-plan adjustment from #3863/#3870 to the first two eligible reports in
  selected order: #3870/#3558. The original manifest remains intact.

These reports were not used to tune code-location, but were previously assessed
for readiness and come from the same repository. Several supply detailed source
hints. This is a small development portability/quality check, not an independent
accuracy estimate or a model comparison. Prompts/tools were not tuned during the
trial. Extracting the existing location-record validator into a shared module
changed the runtime identity without changing model behavior.

Frozen location runtime:
`ca04d8acc6a37507960889995d674491f2115d6e97bc1df460eeb68c805eded4`.
Readiness runtime remained:
`16475b114f1577937d590945638f40bf6b28602f8069cbfd53099d7317100945`.

## Assistant review of usefulness

| Report | Primary result | Evidence and limits |
| --- | --- | --- |
| #3863 Linux SIGTRAP crash | Needs information; no location run | The report's trigger is unverified. The fresh assessment asks for a specific action/system state or repeatable sequence. This is a defensible question, but its difference from the earlier ready assessment exposes readiness variance. One rerun cannot establish which policy is consistently applied. |
| #3870 terminal escapes in project paths | Useful, narrow starting point | Shared path validator, API request schema, and domain validation assertions form a coherent path. Tests cover path formats, not control characters; CLI output/storage was not inspected. |
| #3558 browser automation steals focus | Useful focus test, shallow code trace | Primary run found desktop-manager state/types and a CDP test asserting no focus/show/restore calls. That is relevant to window activation, but does not establish cross-thread input/panel behavior. The actual focus call found in search was not read. |
| #2602 symlinked project slash commands | Strong discovery/test pairing | `walkMarkdownTree` skips symlinks and `scanCommandRoot` consumes its output. The selected test explicitly expects symlinked files/directories to be absent. It uses `.agent/commands` and an external target, rather than the reported `.claude/commands` in-project target; root handling was not traced. It documents current behavior, not whether the request should be accepted. |
| #3337 Claude OAuth expiry | Relevant classification code, incomplete test lead | Result translation and error classification are useful entry points. The test pointer is an authentication-error fixture, with no downstream assertion read. Recovery forwarding/UI was not inspected. The brief acknowledges both gaps. |

Review checked quoted ranges and surrounding pinned source. No report was
reproduced, no test was run, and no claim of a confirmed bug or maintainer
acceptance follows from these assessments. A packet marked completed means its
workflow finished, not that its proposed investigation is complete.

## Repeat consistency

Both repeats used exactly the same parent record, issue input, commit, provider,
model, prompt, and runtime as their primary location run.

| Report | Code paths | Test paths | Interpretation |
| --- | --- | --- | --- |
| #3870 | Same 2/2 paths; identical code ranges | Same test file; repeat included 11 additional preceding lines | Stable candidate selection in this pair. Both leave control-character behavior and rendering unverified. |
| #3558 | No shared paths: manager versus plugin opening/CDP adapter | No shared test paths | Repeat found plausible hidden-tab/control entry points but cited a close/release lifecycle test instead of the primary's focus assertions. Test relevance regressed, despite exact grounding and explicit caveats. |

Different paths can be complementary; overlap alone is not a quality score.
Here, reading the assertions establishes the meaningful regression in the
browser-focus repeat. One repetition per case is not a stability estimate.

## Runtime and artifact checks

| Location attempt | Model steps | Inspection calls | Code/test citations | Seconds |
| --- | ---: | ---: | ---: | ---: |
| #3870 primary | 6 | 5 | 2 / 1 | 15.7 |
| #3558 primary | 10 | 11 | 3 / 2 | 34.3 |
| #2602 primary | 9 | 9 | 2 / 1 | 23.1 |
| #3337 primary | 11 | 10 | 3 / 1 | 21.6 |
| #3870 repeat | 6 | 5 | 2 / 1 | 17.1 |
| #3558 repeat | 10 | 9 | 2 / 1 | 25.5 |

Steps and inspection calls differ because a step can contain multiple tools;
submission is not a source inspection. OAuth used the reserved submission-only
phase and returned an honest incomplete test lead instead of exhausting the run.
Times cover location execution, not provider setup or reused readiness work.

The seven new agent runs (one readiness, six location) reported 278,603 input
tokens, including 231,569 cache-read tokens, and 6,600 output tokens. Historical
reused readiness usage is excluded. Reported cost was zero; actual billed cost
and subscription quota use are unknown.

The saved offline `audit.mjs` validates all seven packets and parent handoffs,
checks all 24 inspected excerpts and 21 citations against Git blobs, and verifies
byte-identical Markdown regeneration. It also confirms the 12 historical inbox
location records remain readable and the frozen runtimes still match. Packet
JSON carries the raw records; the Markdown renderer needs no checkout or model.

`npm run verify` passes 49 tests. Packet checks cover both-agent execution,
readiness reuse, non-eligible outcomes, exclusive output admission, stale records,
source failure, cancellation, invalid assessments, not-located partial results,
handoff/quote tampering, and safe Markdown. These scripted checks establish
software behavior, not task accuracy.

## Next bounded improvement

Keep the two agent responsibilities and the packet consumer. Improve how
code-location spends its inspection budget: follow a test fixture to the test
that consumes it and read its assertion; prefer behavior tied to the reported
symptom over a nearby lifecycle test; trace a discovered focus/activation call
before spending more reads on declarations. If the budget ends first, retain an
explicit limited lead. Develop against the OAuth/browser examples, then check
new reports without tuning on them. Broader orchestration and autonomous fixes
are not justified by this trial.
