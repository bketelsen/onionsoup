# Following fixtures to assertions — 2026-09-18

Code-location v5 adds bounded test-navigation hints and changes inspection
priorities. It improves the OAuth report from a fixture-only pointer to an actual
recovery assertion. It also finds focus-changing code and relevant assertions in
one browser-focus run, but its repeat still stops at setup. Five synthetic cases
pass; the real trial demonstrates useful progress, not consistent task quality.

The trial also exposes a separate summary-grounding error on a new report. This
is recorded below rather than hidden by successful execution or exact quotations.

Local artifacts: [five real packets](../runs/test-selection-2026-09-18/index.md),
`runs/test-selection-2026-09-18/audit.json`, and the synthetic corpus run under
`runs/test-selection-2026-09-18/synthetic/development-SEChcT/`.
Raw runs remain ignored local data; this report is published with the source.

## Change and boundaries

Test reads now suggest same-file consumers of up to two function declarations in
the read window, with at most two references per symbol. Each hint includes a
preceding lexical test heading and a following assertion line, when recognized.
A continuation hint points toward an assertion after the current window.
Assertion searches stop at the next recognized test heading or 120 lines.
Previews are capped at 180 characters. These JS/TS/Python heuristics operate on
the already admitted pinned blob; they do not execute source or establish scope,
semantic relevance, or coverage. Their output consumes the existing context
budget and never grants a citation without a subsequent bounded read.

The prompt asks for test investigation after the first useful implementation
read, follows fixture consumers through to assertions, and distinguishes symptom
assertions from nearby lifecycle/access-control checks. It also favors actual
behavior-changing calls over additional declarations. If only a fixture/setup
or an unrelated assertion is available, it asks for an empty test list and a
specific limitation. The repeat below shows this instruction is not reliable.

The agent's public contract, tools, authority, and 12-step/12-inspection/180-second
limits are unchanged. Prompt version is `code-location-v5`; the frozen runtime
for every trial run is
`1647f0f5ab3685383711c2bfa697256d796ef993960db479af9b4b7513c84f79`.
Readiness behavior was not changed. Historical packet/location records remain
readable, with their original results and versions intact.

## Validation design

`npm run verify` passes 53 software tests. The four new tests cover distant
fixture navigation, continuation boundaries, bounded/literal symbol matching,
and pinned-source hints that cannot authorize unread citations. The source
fixture deliberately differs from the dirty working copy in the integration
test. These checks establish software properties, not judgment quality.

`npm run eval:location` now has five Terra-only live development cases. The three
existing sparse/misleading/injection cases remain; the new cases require an
actual distant authorization assertion and a focus assertion rather than the
nearby release-on-close assertion. All five passed their expected code/quoted
assertion checks. Expectations stay outside model context; fixture code is never
executed. These small constructed cases are not a general accuracy estimate.

The real trial uses Copilot `gpt-5.6-terra` and the same pinned `get-bb/bb` commit
as the previous packet trial:
`3a4288bd0f34f888a5eb43f1099f7b60fe86eea4`.
It reuses exact readiness records for #3337 and #3558, repeats #3558 with identical
input/parent, then runs #3892 and #3905. The latter are the next two unused
reports in the preceding frozen selection order. They were previously assessed
for readiness, but not used to tune code-location. Prompt/runtime were frozen
before results; no changes were made in response to these new cases.

## Assistant review

| Report | Result and comparison | Remaining limitation |
| --- | --- | --- |
| #3337 OAuth expiry | Improved from a fixture near line 400 to its consumer near line 3737 and the `authRequired` recovery assertion at 3758–3772. The trace used the new fixture-reference hint. | Tests bridge recovery notification, not error classification or product sign-in behavior. Reached the full 12-step limit including submission correction. |
| #3558 browser focus | Primary run found `webContents.focus()` at 973–979, notification handling, and the controlled-target focus/show/restore assertions at 1904–1929. This is a stronger code trace than v4's state/type declarations. | Does not establish the plugin-to-manager call chain, cross-thread input/panel behavior, or macOS activation. |
| #3558 repeat | Found the same focus helper plus visibility handling, and a relevant hidden-capture test. | Stopped its quotation at setup line 2139; the useful focus assertion is at 2148, outside its read window. Also cited a wrapper/CDP lifecycle assertion. It acknowledges the gap but still violates the prompt's preference against setup-only test pointers. |
| #3892 preview after reload — new | Useful manager test asserts hiding only the reloading window and showing it again after attach. | **Summary error:** claims the pinned commit contains a host-navigation cleanup listener. The inspected `main.ts` range only contains a `before-input-event` reload-shortcut listener; the file has no literal `did-start-navigation`. Its own uncertainty says navigation-listener existence was not established. Exact source quotations did not prevent this unsupported summary. |
| #3905 subdirectory diffs — new | Found the pathspec helper and its concrete diff call sites; returned an empty test list with explicit search limits. | Searches for private helper names did not reach public-behavior tests; working-tree context construction was also not reached. This is an honest limited result, not proof that relevant tests are absent. |

Source review checked the quotations and surrounding pinned code without running
the project or reproducing symptoms. The #3892 summary should not be relied on;
the raw result is retained as evidence of the failure. No maintainer acceptance
or broad accuracy score is inferred from this assistant review.

## Runtime and exact grounding

| Attempt | Model steps | Inspection calls | Code/test citations | Seconds |
| --- | ---: | ---: | ---: | ---: |
| #3337 development | 12 | 10 | 3 / 1 | 28.5 |
| #3558 development | 12 | 10 | 3 / 2 | 29.0 |
| #3558 repeat | 12 | 10 | 2 / 2 | 30.4 |
| #3892 new | 8 | 6 | 2 / 1 | 22.9 |
| #3905 new | 11 | 9 | 3 / 0 | 29.1 |

All five real runs completed. The offline audit matched all 19 real citations
and 23 inspected excerpts against the Git blobs; the synthetic runs add 11 exact
citations and 11 excerpts. All five packet Markdown files regenerate identically.
The seven previous packets and 12 historical inbox location records still
validate. This grounding check establishes quotation accuracy, not summary truth
or test relevance, as #3892 illustrates.

The next work should address two concrete weaknesses: retaining enough inspection
capacity to finish a promising test, and tying summary claims to inspected
behavior rather than conflating similarly named event paths. Keep the failures
as regression evidence. Adding more agents or granting code execution would not
resolve those decision problems by itself.
