# Evaluation record: Aggregate repository brief — 2026-09-18

Historical evidence appendix to [the evaluation plan](../evaluations.md), completing
[backlog P7](../backlog.md#phase-7--repository-brief). This is assistant development
review, live integration evidence and deterministic validation, not independent
maintainer acceptance or a task-accuracy estimate.

## Method and boundaries

Invoke the real repository-brief CLI against `get-bb/bb`, with a seven-day activity
window and at most three action suggestions. Both attempts used Copilot
`gpt-5.6-terra`, AgentLayer 0.0.36 and prompts `repository-themes-v1`,
`repository-health-v1`, `maintenance-actions-v1`. Each recipe allowed four agent
attempts and at most 20 API requests. Theme input was the first 30 captured open
issue titles/labels and 30 open PR titles/labels; no body, comment, diff or review
inspection. No target code execution, GitHub writes, delivery or scheduling occurred.

A private plan froze all source file hashes and `package-lock.json` before each
attempt. The corrected trial runtime digest was
`80feb9724c75931fc8b759a3fefd3be9bec86ff1a11406c741897447892caa16`.
Hashes matched after execution. A later rendering-only change added direct links
to failed CI runs from saved metadata, without inference or input/result changes.

Before execution, checks were: correct reporting-window counts versus samples,
explicit CI denominator and contributor-history coverage, exact disjoint theme
membership, valid health/action evidence references, no title-based merge approval,
no unsupported trend claims, and truthful failures with offline rendering.

## Results and evidence

Both attempts remain in ignored `runs/repository-briefs/`, with private plans and
audit records. Dates in this filename are local America/New_York; timestamps below
are original UTC.

| Attempt | Workflow | Outcome |
| --- | --- | --- |
| `p7-live-2026-09-18` | `556ba89e-0016-47be-a015-cd624e91e953` | Partial; **not qualified**, collection query defect |
| `p7-corrected-2026-09-18` | `39d5d436-66c9-4a19-ae9b-96a25dfd2909` | Completed bounded recipe; coverage remains sampled |

The first run lasted from `2026-09-19T01:09:47.693Z` to
`2026-09-19T01:10:36.512Z`. GitHub ignored repeated date comparison qualifiers,
returning all-time totals for activity searches. Membership validation rejected
out-of-window rows, making the recipe partial, but metric code still treated the
totals as trustworthy. This was a genuine collection/metric bug; those generated
summaries are not evidence of correct reporting-window behavior.

A direct API comparison found 866 issues with the defective created-time query
versus 97 with one inclusive date range. The correction uses a single range with
second-resolution endpoints representing the requested half-open interval. Any
rejected source row now makes that collection's count untrustworthy. A regression
test covers query shape, exact/fractional boundaries, out-of-window rejection and
count trust. Current validation rejects the first attempt's unsupported query
provenance; its original artifacts are preserved rather than relabeled or replayed.

The corrected run lasted **48.119 seconds**, from `2026-09-19T01:12:29.701Z` to
`2026-09-19T01:13:17.820Z`, with activity window
`[2026-09-12T01:12:29.699Z, 2026-09-19T01:12:29.699Z)`.
It made **19 API requests and four agent attempts**, with no rejected rows or
incomplete-search flags. Its 27-event trace preserves collection/stage identities,
reservations, agent runs, outcomes and provider usage without raw task prose.

| Metric | GitHub-reported total | Captured membership |
| --- | --- | --- |
| Open issues at collection | 350 | 100; themes cover 30 |
| Open PRs at collection | 56 | 56; themes cover 30 |
| Issues created in window | 97 | 97 |
| Currently closed issues with closure in window | 70 | 70 |
| PRs created in window | 264 | 100 |
| PRs merged in window | 201 | 100 |
| Closed-unmerged PRs with closure in window | 37 | 37 |

The CI sample covered 100 of 691 default-branch Actions runs: 51 successful,
7 failed, 42 excluded from the denominator. **51/58 = 87.9% is a sample rate**,
not a repository-wide rate. The collector checked ten of nineteen sampled non-bot
PR-author candidates; five had their first PR in the window. Nine candidate
histories were unchecked, and the created-PR population itself was capped.

Each theme result partitioned its 30 supplied IDs exactly once. Code, not the
model, computed these group sizes:

| Issue theme | Count | PR theme | Count |
| --- | --- | --- | --- |
| Claude configuration, skills and sign-in | 5 | Plugin management, packaging and docs | 9 |
| ACP capabilities and bridges | 7 | Thread, timeline and sidebar UI | 8 |
| Desktop/browser integration | 5 | Drafts, messaging and agent interaction | 5 |
| Plugin/workflow/workspace APIs | 6 | Command palette and shortcuts | 3 |
| Thread/diff/interface behavior | 6 | Runtime, package tooling and automation | 4 |
| Terminal escape handling | 1 | ACP file-write response | 1 |

Assistant review found these useful broad groupings, with some intentionally
mixed categories. They describe metadata themes, not validated changes or complete
repository coverage. Every health/action evidence ID resolves. Health observations
preserve the window, sample denominators, unknown history and absence of a trend
baseline. They mostly restate metrics, which is accurate but somewhat verbose.

The three proposed actions were to inspect the seven sampled CI failures, review
PR #3923 alongside issue #3921 (reduced-motion status glyphs), and review PR #3887
alongside issue #3886 (skill-invocation thread titles). The saved titles support
both proposed pairings. The wording asks for review/verification, not merging or
claiming either fix works. References to confirmed reproduction come from the
issues' `confirmed-repro` labels; this recipe performed no reproduction.

Offline rendering preserved the root record, and generic event export matched the
saved trace exactly. HTML provides item/evidence links and failed-CI-run links,
with inert text, no scripts or remote assets. Automated artifact checks cover
escaping, identity and regeneration. Visual browser inspection was unavailable
in this session; no claim of a completed visual review is made.

Fifteen new software tests cover arithmetic and coverage, invalid group membership
and references, bounded correction, cancellation, source/provider/storage failures,
credential-shaped context redaction, context bounds, empty/disabled stages,
contributor request caps, exclusive/private artifacts, date-query regression and
offline rendering. **117 tests pass**, with documentation, types, generated schemas
and the credential-free AgentLayer demo. Fixtures do not establish model accuracy.

## Limitations and next step

A single corrected repository trial is insufficient for reliability qualification.
Titles and labels support broad themes and review leads, not diagnosis, actual diff
classification or acceptance. No previous-period baseline, all-history contributor
census, external CI or job-log analysis was added. Large repositories remain sampled.
The first live defect demonstrates why deterministic host code also needs real API
verification; passing mocked tests was insufficient.

The implemented adapter is on-demand CLI with local artifacts. Packaging is a local
source bundle with public functions and manifests, not a separately published SDK
or deployed service. Scheduled email is [planned P8](../backlog.md#phase-8--scheduled-delivery):
configure a recipient and schedule, persist delivery identity, and retry delivery
from saved results without repeating analysis. Webhook/MQTT/GitHub event adapters
remain documented directions.

## References

- Plan phase: [evaluation plan — Phase 9](../evaluations.md#phase-9--aggregate-repository-brief).
- Rationale: [ADR-0010](../../adr/0010-compose-a-repository-brief-from-bounded-evidence.md).
- Context: [packages and recipes](../../design/packages-and-recipes.md), [validation](../../design/validation.md).
- Contracts: [repository brief](../../specs/repository-brief.md), [discovery/events](../../specs/agent-discovery.md).
