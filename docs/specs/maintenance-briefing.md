# Spec: On-demand maintenance briefing, version 1

The briefing is a deterministic CLI consumer of the existing readiness workflow
and location handoff. It captures public issue snapshots and produces a readable
maintenance report with private evidence and a common trace, without a new agent.

## Interface

```sh
npm run briefing -- get-bb/bb --checkout .local/repos/get-bb--bb
npm run briefing -- get-bb/bb --checkout .local/repos/get-bb--bb --issues 3886,3337 --provider copilot
npm run briefing -- render runs/briefings/DIRECTORY
npm run agents -- events runs/briefings/DIRECTORY/briefing.json
```

`--checkout` is required. `--commit` accepts a full lowercase Git SHA; otherwise
resolve the checkout's HEAD once. `--count` is 1–5 (default 5). `--issues` accepts
1–count distinct positive issue numbers, in caller order. `--provider` selects
Copilot or Codex (default from `ONIONSOUP_PROVIDER`, otherwise Copilot). The model
is explicitly `gpt-5.6-terra`; no fallback or comparison. Use existing subscription
configuration and authenticated `gh` for read-only GitHub intake.

`--output` names a new directory whose parent exists. Otherwise the command creates
a unique directory beneath ignored `runs/briefings/`. Existing directories fail
before source or model work. JSON stdout gives directory, workflow ID, status and
budget. Invoke `node --import tsx src/briefing-cli.ts` to avoid npm's header.
Exit 0 means completed; partial, failed, unfinished render, or command errors exit 1.
`render DIRECTORY` validates saved JSON and regenerates Markdown/events without
GitHub, source reads, credentials, model calls, or resume.

The root record is `schemaVersion: 1`, `kind: maintenance-briefing`:

| Field | Meaning |
| --- | --- |
| `workflowId`, `startedAt`, `finishedAt?`, `status` | Root identity and running/completed/partial/failed outcome |
| `repository`, `commit?`, `execution` | Requested repo, validated pinned source, provider/model |
| `budget` | Shared allowance: limit 7, consumed reservations, remaining |
| `intake?` | Method, timestamps, requested count, inspected entries, window fullness, snapshots and rejections |
| `readiness?` | Original validated readiness workflow and child records |
| `locations` | One ordered slot per captured snapshot with disposition and optional original handoff |
| `failure?` | Sanitized source_unavailable/intake_failed/execution_error/cancelled |

`intake.issues` retain exact title/body and update timestamp, observed state/time,
and the number of comments excluded. Rejections retain number and reason
`invalid_snapshot` or `unavailable`. Default selection considers at most 100 API
entries sorted by update time descending (number descending breaks ties), filters
open non-PR issues, and captures up to count valid snapshots. This is a bounded
window, not an exhaustive scan. Explicit selection may include closed reports.
Oversized snapshots are rejected without truncation. A failed or cancelled intake
has no completed captured set; no readiness begins before intake is persisted.

## Rules

- Pin and validate an existing checkout's origin/commit before intake or inference.
  Source acquisition, fetch, target code execution, and GitHub mutation are absent.
- Assess at most five exact snapshots in capture order using the existing
  [readiness workflow](readiness-workflow.md). Classification implies no acceptance.
- Select the first two completed ready bug reports in capture order for the
  [location handoff](location-handoff.md). Selection is a capacity policy, not priority.
- Use one seven-invocation allowance. Persist reservations before adapter startup.
  Failed initialization consumes an attempt; there is no retry/fallback/refund.
  An invocation is one agent attempt, not one model turn or a token/cost cap.
- Retain per-agent limits and a cooperative 15-minute overall signal. Cancellation
  stops further admission. Unknown unfinished attempts prevent later location work.
- Location slots distinguish `not_eligible`, `readiness_unavailable`,
  `selection_limit`, `cancelled`, `prior_attempt_unfinished`, `pending`, and `handoff`.
  Handoffs retain located/not_located/failed/unfinished/not_attempted outcomes.
- Completed means all captured assessments and selected locations completed as
  intended; deliberate capacity skips and ineligible reports do not make it partial.
  Rejections, failed/unavailable work, cancelled work, or not-located results make
  it partial. Root failures are failed unless at least one assessment completed.
- Save root JSON atomically throughout execution in a private exclusive directory
  (0700; files 0600). Storage failures stop work and leave the last saved state as
  truth. Running records are unfinished/unknown, never evidence of success.
- Validate exact captured inputs, parent identity, source, model/provider, child
  identities and reservation continuity. Rendering rejects inconsistent artifacts.
- Render prose inertly and quotations in safe fenced blocks. All source links use
  the pinned commit. Tests are reading suggestions with model-assessed relevance,
  not measured coverage or verified fixes. Quota and billed cost remain unknown.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| `briefing.json` | Private root checkpoint with original child records |
| `briefing.md` | Human report: findings, questions, citations, uncertainty, failures and skipped work |
| `events.json` | Metadata-only [event export](agent-discovery.md), one root workflow |

Child events retain optional `childWorkflowId`, run IDs and handoff parent workflow
IDs; reservation counts span both stages. Reused readiness is historical usage,
not another invocation. `selection_limit` is an explicit skipped-stage reason.
Strict event consumers need the current schema. Projections can be regenerated if
interrupted after JSON persistence. This is not a durable resume or replay API.

## References

- Rationale: [ADR-0009](../adr/0009-produce-a-bounded-maintenance-briefing.md).
- Context: [composition design](../design/composable-agents.md).
- Delivery: [backlog P6](../plans/backlog.md#phase-6--on-demand-maintenance-briefing).
- Evidence: [evaluation plan](../plans/evaluations.md#phase-8--on-demand-maintenance-briefing).
