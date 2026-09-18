# Read-only intake pilot — 2026-09-18

The pilot exercised the new intake workflow against `get-bb/bb` with Copilot
`gpt-5.6-terra`, prompt `bug-readiness-v4`, and assessment contract v2. It changed
no GitHub issues and required no human grading. This is evidence of operational
behavior, not a new accuracy evaluation or a promotion through the human gate.

## Live observations

Each refresh fetched the latest 100 issue API entries, sorted by update time,
including closed entries and pull requests. Those entries contained 25 issues:
17 open and 8 closed. The other 75 entries were pull requests, which were excluded.
The page limit was reached; this is not full repository coverage.

| Refresh | Assessment cap | Known open contents skipped | New assessments | Completed | Failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| First | 5 | 0 | 5 | 5 | 0 |
| Second | 5 | 5 | 5 | 5 | 0 |
| Finish remaining queue | 10 | 10 | 7 | 7 | 0 |
| Normal repeat | 5 | 17 | 0 | 0 | 0 |

The final normal refresh made no model calls. A SHA-256 comparison confirmed all
17 original attempt files were unchanged. Each first-time assessment used a fresh
point read before model admission; the repeat needed only its list request.

The resulting inbox contains 11 reports marked ready to investigate, one needing
information, five feature requests, and eight observed closures. All request kinds
remain descriptive, not acceptance decisions. There is no remaining queue within
the observed window, no failed attempt, and no unresolved interrupted attempt.

Seventeen assessments took 19 logical steps: #3607 and #3863 each needed a second
step. SDK totals report 40,951 input tokens and 5,066 output tokens, including
correction work. These counters are not actual subscription cost or quota usage;
those remain unknown. No fallback model or Luna call was used.

Artifacts are in `runs/inbox/get-bb--bb/`. `index.html` is the user-facing inbox,
`summary.json` provides operational metrics, and `refreshes/` and `records/`
preserve invocation/attempt provenance. These live artifacts will update on later
refreshes; this document records the pilot observations at completion.

## Engineering validation

`npm run verify` passed typechecking and all 33 tests, including ten new inbox
checks. The new checks cover content reuse across metadata changes, retaining
changed snapshots, caps and queue progression, PR exclusion, invalid inputs,
point-read edits/closures/stale responses, failed-attempt retention and explicit
retry, concurrent refresh prevention, cancellation, a source-request deadline,
source failure without stale model work, dead-process recovery with live-owner
refusal, corrupt/configuration-mismatched state, and inert HTML rendering.

A headless Chromium check exercised the real local inbox: assessed/category
filters, proposed questions, issue-number search, empty search results, and mobile
layout without horizontal overflow or JavaScript errors. The browser check did
not create human acceptance feedback.

## What remains uncertain

Maintainer usefulness and classification correctness remain ungraded. Several
reports overlap earlier development/pilot inputs; this was not a fresh held-out
set. The inbox deliberately excludes comments and attachments and records only a
bounded window of GitHub updates. Changes outside that window can be missed until
they enter a later scan or the window is enlarged.

Crash, cancellation, recovery, changed-content, and closure behavior were exercised
with scripted fixtures; the live repository was never edited to force those cases.
The successful live repeat establishes reuse for the observed unchanged contents,
not a guarantee of exactly-once provider execution after a crash. Persisted
admission records make uncertain interrupted work visible instead of retrying it
automatically.

The next useful feedback is from using the inbox: whether its groupings and
proposed questions help with actual issue handling. The [inbox guide](inbox.md)
covers refresh, retry, recovery, and operational limits.
