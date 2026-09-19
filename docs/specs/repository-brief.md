# Spec: Repository brief and focused summary capabilities, version 1

The repository-brief recipe collects bounded GitHub evidence, calculates metrics,
invokes three narrow capabilities, and produces an on-demand maintainer report.
The local bundle's public exports are in
[index.ts](../../src/repository-brief/index.ts). It does not change readiness or location.

## Interface

```sh
npm run repo-brief -- get-bb/bb --days 7 --max-suggestions 5 --provider copilot
npm run repo-brief -- get-bb/bb --since 2026-09-11T00:00:00Z --until 2026-09-18T00:00:00Z
npm run repo-brief -- render runs/repository-briefs/DIRECTORY
npm run agents -- describe repository-themes
npm run agents -- events runs/repository-briefs/DIRECTORY/repository-brief.json
```

`BriefRequest` v1 contains repository, `since`, `until`, and `maxSuggestions` (0–10,
default 5). The activity window is half-open `[since, until)`, at least one second and at most
90 days. CLI `--days` defaults to 7; `--since` and `--days` are mutually exclusive.
CLI `--until` defaults to now and rejects future end times. `--max-suggestions 0`
disables the action stage. Open backlog is observed at collection time, regardless
of the activity window; this command does not reconstruct historical open state.

Provider selection is explicit: `--provider`, then `ONIONSOUP_PROVIDER`, then
Copilot. Model is fixed to `gpt-5.6-terra`. Existing subscription credentials and
an authenticated `gh` with repository read access are required. No target checkout
is required. `--output` names a new directory with an existing parent; default is
a unique directory beneath ignored `runs/repository-briefs/`.

Use `node --import tsx src/repository-brief/cli.ts` for pure JSON stdout. Exit 0
means the recipe completed its bounded work, including intentional empty/disabled
stages; exit 1 means partial, failed, unfinished render, or command failure.
Sample completeness is separate from recipe completion and always displayed.

### Deterministic collection and metrics

The collector uses at most 20 read-only GitHub API requests (currently at most 19):
seven searches, repository metadata, one Actions page, and up to ten author-history
searches. Every request has a 30-second timeout and 8 MiB response bound. There is
no pagination or automatic collection retry. Each search inspects at most 100
items sorted by update time descending. Source observations and query strings are
retained; responses are projected into bounded metadata, not full API dumps.

| Collection | Exact meaning |
| --- | --- |
| Open issues / PRs | Separate current open populations at collection |
| Created issues / PRs | Creation timestamp within the activity window |
| Closed issues | Currently closed issues with closure timestamp within window |
| Merged PRs | Merge timestamp within window |
| Closed-unmerged PRs | Currently closed unmerged PRs with closure within window |

Totals come from GitHub search `total_count`; incomplete search, rejected rows or
failed requests render totals unknown. Date filters use one inclusive range with
second-resolution endpoints corresponding to the half-open requested interval;
repeated comparison qualifiers are not accepted query provenance. A known total does not imply complete captured membership.
Duplicate, oversized, mismatched-repository or invalid rows are rejected and counted,
not truncated. Reopen/close events are not measured. Search indexing and observations
across separate requests preclude atomic snapshot or exhaustive historical claims.

CI covers GitHub Actions runs on the observed default branch, created in the
window, at most 100 from one response. The API's inclusive date range uses the same second-resolution
endpoints; rows are also checked against the half-open window. Any unexpected
boundary exclusions remain visible as rejected rows and partial coverage. Each run's latest observed attempt is counted once;
reruns are not independent denominator entries. On completed runs, success is the
numerator; success, failure, timed_out, action_required and startup_failure form
the denominator. Pending, cancelled, skipped, neutral and unknown conclusions are
excluded. Zero denominator or unavailable CI means unknown rate, not 0% or 100%.
External CI, job logs and flakiness are outside this evidence. Renderers link
failed runs from saved IDs/names; health/action agents see aggregate CI metrics only.

New contributors means **first-time PR authors**. From captured created PRs, collect
distinct non-bot authors, sort login, and check at most ten. Query each author's
earliest PR in the repository across history. A first creation within the window
establishes a new PR author; incomplete/failed history is unknown. Unchecked
candidates and a capped created-PR population keep coverage partial. This excludes
issue-only, commit-only and other contribution types. No previous-period baseline
is collected; models must not claim a trend.

### Agent contracts

All three agents accept supplied data only, expose just `submit_result`, and have
three logical steps, a cooperative 60-second deadline and a 60,000-character input
bound. They return v1 running/completed/failed records, input hashes, prompt identity,
metadata events, provider usage when available, private state and validated results.
They receive no source, shell, GitHub or email tools. Titles/labels and model output
are untrusted data, never authorization. Known credential-shaped strings are
redacted in derived title/label context; original private snapshots remain intact.
Direct callers must supply redacted inputs. This is not a general sensitive-data detector.

| Capability | Input | Result and validator |
| --- | --- | --- |
| `repository-themes` | Repo, snapshot hash, issues/PR collection, 1–30 item IDs with titles and labels | Groups with label, summary, member IDs; every supplied ID exactly once, no invented members or duplicate labels |
| `repository-health` | Snapshot hash and bounded evidence IDs/statements | Up to five observations with evidence references, plus limitations |
| `maintenance-actions` | Snapshot hash, bounded evidence and requested maximum | Zero to N ordered action/rationale/reference proposals, plus limitations |

Prompt versions are `repository-themes-v1`, `repository-health-v1`, and
`maintenance-actions-v1`. The theme input is explicitly title/label-only; bodies,
comments, diffs and reviews are excluded. The first 30 captured open items form
each theme sample. Code counts validated member IDs. Models must label uncertainty
and avoid inferring readiness, acceptance, implementation, priority or merge safety.

Health consumes deterministic metrics. Actions consume those metrics, sampled
item evidence, successful theme groups and verified new-author evidence. A theme
failure does not prevent evidence-based action suggestions from the remaining
sources. Reference validation establishes membership, not semantic truth. Fewer
than N suggestions is valid. No suggestion is executed.

## Rules

- Use one four-invocation allowance: issue themes, PR themes, health, actions.
  Reserve and persist before provider initialization; initialization failure consumes
  a reservation. Empty-data or disabled stages spend none. No fallback or task retry.
- Each provider/model selection must match the recipe execution identity. Physical
  transport behavior remains provider/SDK-owned; the allowance counts agent attempts,
  not HTTP requests, tokens, quota or billed cost. Unknown cost stays unknown.
- Use a cooperative ten-minute recipe deadline. Cancellation stops later admission.
  An unexpected exception after child admission preserves an unfinished child and
  prevents subsequent admission; recorded failures may allow independent stages.
- Persist root intent before collection, then the complete captured snapshot before
  inference, each reservation, child admission/final state, and recipe termination.
  Collection has no per-request durable checkpoint or resume. A crash leaves its
  collection outcome unknown. Persistence failures stop further work.
- Reject existing output directories. Root and child records are private (0700
  directory, 0600 files). Renderers validate request/snapshot/child identity, budget
  continuity, output invariants and original timestamps without model calls.
- Failed/incomplete API sections, rejected rows or failed/unattempted required agents
  make the recipe partial. Entirely unavailable collection fails. Deliberate bounded
  sampling alone does not fail the recipe; report all population/sample denominators.
- Render untrusted text inertly, link item references to the requested repository,
  preserve uncertainty and keep structured evidence separately inspectable.

## Derived artifacts

| Artifact | Purpose |
| --- | --- |
| `repository-brief.json` | Root request, execution identity, snapshot/hash, shared budget, stage records |
| `repository-brief.md` | Counts, aggregate themes, health, up to N suggestions, evidence and provenance |
| `repository-brief.html` | Script-free HTML view with evidence links and coverage |
| `events.json` | Common metadata-only derived trace; collection plus four stage identities |
| `capabilities/*.json` | Generated manifests and input/result schemas for the three agents |

`render DIRECTORY` regenerates all projections without credentials, GitHub calls,
model inference or rewriting the root record. Generic `agents events` accepts root
JSON or any individual new agent record. Common events add the three agent IDs,
`submit_result`, `no_valid_result`, `stage.completed`, `stageKey`, and empty/disabled
skip reasons; strict consumers need the current schema. Existing exports retain
their semantics. MCP discovery lists the new capabilities, but they are not added
to that adapter's invocable set.

## References

- Rationale: [ADR-0010](../adr/0010-compose-a-repository-brief-from-bounded-evidence.md).
- Context: [packages and recipes](../design/packages-and-recipes.md), [composition](../design/composable-agents.md).
- Delivery: [backlog P7](../plans/backlog.md#phase-7--repository-brief).
- Discovery: [capability and event contract](agent-discovery.md).
- API semantics: [GitHub search](https://docs.github.com/en/rest/search/search),
  [Actions runs](https://docs.github.com/en/rest/actions/workflow-runs).

Delivery consumer: [scheduled delivery](scheduled-delivery.md), following
[ADR-0011](../adr/0011-separate-scheduled-analysis-from-mail-delivery.md).

Packaging and host composition follow [ADR-0022](../adr/0022-package-capabilities-with-thin-host-applications.md)
and the [workspace package contract](workspace-packages.md).
