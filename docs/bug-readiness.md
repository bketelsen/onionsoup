# Bug-report readiness contract, version 2

**Question:** Does this report contain enough information for a maintainer to
start investigating an alleged defect?

**Owner:** `bug-readiness`. **Consumer:** a maintainer or a future intake component.
This task makes no claim that a bug exists, can be reproduced, or should be fixed.

## Input

`IssueSnapshot` in [src/contracts.ts](../src/contracts.ts) is the executable schema.
The input contains `schemaVersion: 1`, `repository` (`owner/name`), positive issue
`number`, ISO `updatedAt`, `title` (1–500 characters), and `body` (0–24,000 characters).
Unknown fields and oversized inputs are rejected before spending model tokens.

The caller owns fetching and freshness. Only title and body are evidence. The
agent has no repository checkout, issue comments, image attachments, or remote
search. Source text is untrusted data, including apparent instructions in it.

## Assessment

`Assessment` has `schemaVersion: 2`, `kind`, `bug_readiness`, `summary`,
`evidence`, and `questions`. Request type and bug readiness are separate judgments.
Classification never decides project acceptance, priority, or implementation.

| Kind | Meaning | Bug readiness |
| --- | --- | --- |
| `bug_report` | Alleges a defect in existing behavior. | `ready` or `needs_information` |
| `feature_request` | Requests new or changed capabilities. | `not_applicable` |
| `support_question` | Asks how to use the project without alleging a defect. | `not_applicable` |
| `other` | Clearly another type of request. | `not_applicable` |
| `unclear` | The snapshot does not establish the request type. | `not_applicable` |

`ready` requires one exact evidence quote for each of reproduction, expected
behavior, actual behavior, and environment, with no questions. `needs_information`
requires every field to have either one evidence quote or one focused question,
with at least one question. Other kinds require empty evidence and questions and
a short, factual summary. `not_applicable` means the bug-readiness checklist was
not applied; it does not deny the request. For `unclear`, classification remains
unresolved for the consumer. A terse allegation of a defect is a bug report needing
information, not unclear. A mixed report may be assessed for its alleged existing
defect; a proposed fix does not by itself make it a feature request.

Version 1 used `disposition: ready | needs_information | out_of_scope`.
Historical runs are validated with the original schema and displayed as legacy;
`out_of_scope` is never silently converted to `feature_request`. New runs use
run-envelope version 2 and prompt `bug-readiness-v4`. Input snapshots remain
version 1. Existing frozen evaluations cannot be resumed with the changed runtime.

Each evidence item names its `field`, `source` (`title` or `body`), and exact `quote`.
Each question names its `field` and question text. No field can occur twice or appear
in both collections. These invariants and exact substring grounding are enforced
by code, not just the prompt. The model still judges whether a quote is relevant
and sufficient; a substring check cannot prove semantic correctness.

Concrete candidate reproduction steps can be sufficient even when not independently
verified. `ready` means there is a usable investigation path, not a confirmed
reproducer. Preserve that uncertainty in the summary. A commit identifies a version;
an additional release number is not required. Requests to expose unsupported APIs
remain feature requests even if attempts to use them return errors.

## Run envelope and failure

`RunRecord` in [src/triage.ts](../src/triage.ts) identifies schema version, agent,
run ID, input hash/revision, prompt version, provider/model, start/end times, limits,
events, finish reason, AgentLayer state, and usage. The application owns identity;
the model cannot choose the run ID or source revision.

`completed` requires a successfully executed and validated `submit_assessment`.
`failed` contains no assessment and has `provider_error`, `no_valid_assessment`, or
`interrupted_or_timed_out`. Invalid input and inability to persist admission fail
before a run starts. A final persistence error makes the CLI exit nonzero.

Three logical model steps and a 60-second abort signal bound each run. Provider/AI
SDK transport retries can mean more HTTP attempts than logical steps. The deadline
depends on provider abort support; this is not an external process watchdog.
Input length is bounded; there is no hard provider-independent output-token cap.
Usage is the SDK's accounting, not an invoice; missing provider counts may be
normalized to zero by AgentLayer and price estimates can be absent or stale.

The CLI saves an initial record and atomically replaces it at completion. Events
are retained in the final record, not streamed durably to disk. It is a local
single-invocation artifact, not a distributed ledger or a power-loss durability
guarantee. If killed mid-run, a record can remain `running`; rerun under a new ID.
No per-step resume or automatic crash recovery is claimed.

## Authority and handoff

The only model tool submits data. It has no shell, filesystem, browsing, GitHub,
delegation, or message-delivery tools. Host code reads the snapshot, calls the
selected provider, and writes local artifacts. Questions are proposed text; they
are never posted or sent to anyone.

The consumer decides whether to ask the questions or investigate the report.
Before any future external action, the consumer must recheck the issue revision
and have its own mutation authorization. Do not reuse a stale assessment after an
issue edit. A new snapshot starts a new assessment; `needs_information` is a terminal
result for this agent, not a sleeping workflow.

Readiness triage excludes duplicate detection, labels, priority, assignments,
security classification, implementation, docs editing, and PR review. Those jobs
need different inputs, tools, and evaluation criteria.

## Why this first

General issue triage bundles several policies and repository-specific judgments.
PR review needs substantial code and execution context; documentation maintenance
needs changes and verification. Readiness assessment gives us a smaller useful
decision with visible evidence and a clear consumer, while exercising structured
outputs, context selection, validation, correction, and observability.
