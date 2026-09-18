# Spec: Bounded multi-issue readiness workflow, version 1

This deterministic recipe assesses a supplied list through the existing
bug-readiness agent. It supplies a shared invocation allowance and explicit partial
outcomes to a consumer such as Codex. It is not another model-powered agent or an
evaluation batch.

## Interface

`assessIssues({ issues }, options)` in [readiness-workflow.ts](../../src/readiness-workflow.ts)
accepts one to five valid v1 issue snapshots in caller order. A repository/issue
number may appear only once, case-insensitively; duplicate attempts or revisions
are rejected before reservation. Options supply a shared `InvocationBudget`,
explicit model factory, persistence callback, and optional abort signal.
The [MCP adapter](mcp-adapter.md) exposes `assess_issues` and `inspect_workflow`.
For a model-driven consumer, the operator can set `ONIONSOUP_WORKFLOW_INPUT` to a
private JSON file containing `{ issues }`. The CLI reads at most 512 KiB from a
regular file and validates/copies it once at startup. Discovery exposes only the
canonical input hash and issue identities/hashes; `assess_prepared_issues` accepts
that exact hash. The host supplies the stored snapshots. Later file/caller mutation
cannot change the prepared input, and unknown hashes consume no allowance. This
optional tool is absent without prepared input; it grants no arbitrary file reads.
Programmatic callers can still submit exact snapshots through `assess_issues`.
The file-byte limit and the per-snapshot character limits both apply.

The private record has `schemaVersion: 1`, `kind: readiness-workflow`, `workflowId`,
`status`, `startedAt`, optional `finishedAt`, `budgetAtStart`, `budget`, and ordered
`items`. Budget snapshots contain integer `limit`, `consumed`, `remaining` with
`consumed + remaining = limit`. The supported limit is 1–10 invocations.

Each item stores the exact `input`, its canonical `inputHash`, `status`,
`updatedAt`, and, when reserved, `reservation` and `reservedAt`. A child `run` is
the original v2 readiness record. `reason` is present only for failed, unfinished,
or not-attempted outcomes.

| Item status | Meaning |
| --- | --- |
| `pending` | No reservation yet in an unfinished workflow snapshot |
| `running` | Capacity reserved; provider initialization or child execution may be incomplete |
| `completed` | Validated assessment successfully saved; includes non-bug and needs-information outcomes |
| `failed` | Recorded child failure, pre-child execution/configuration error, or cancellation after reservation |
| `unfinished` | Unexpected execution error after a child admission; only a running child record is known |
| `not_attempted` | No reservation or child run; reason is `budget_exhausted`, `cancelled`, or `prior_attempt_unfinished` |

Failure reasons are `agent_failed`, `execution_error`, and `cancelled`. Failed
provider initialization has no child run ID. Unfinished work is never relabeled
failed or successful merely because the adapter returned control.

A terminal workflow is `completed` only when all items completed, `failed` only
when all items failed, and `partial` otherwise. In particular, an exhausted request
with zero new attempts is `partial`, and a mix of failed and unattempted work is
`partial`. A saved workflow lacking terminal persistence stays `running`; event
export labels it `workflow.unfinished`. No automatic retry or resume is supported.

### Shared allowance and persistence

One MCP process owns one budget shared by both single calls and all workflows.
The caller cannot replace it or pass a larger allowance. Capacity is reserved
synchronously before provider initialization. MCP admits one active single call
or workflow at a time. Distinct direct callers must likewise serialize work when
sharing this workflow budget; the callable recipe does not provide a global lock.

A failed attempt consumes its reservation. Discovery, inspection, malformed input,
and unattempted items do not. A repeated request creates a separately attributable
workflow drawing from the remaining allowance; it cannot reset capacity. This is
not an idempotency interface. Process restart resets the allowance, so this is not
a durable quota or cross-process budget.

The workflow saves its initial pending list, each reservation, child admission
and final record, item outcome, and terminal workflow. Every checkpoint is awaited.
MCP saves each complete workflow snapshot to a private file by atomic rename and
updates its inspection maps only after success. Child records are embedded in the
workflow file; standalone calls keep their separate run files.

Any persistence failure stops execution and further admissions. The MCP error
reply includes only the last successfully saved workflow, if any, plus the current
process budget. A reservation whose save failed may have consumed capacity that
is not reflected in the older saved snapshot; it is not refunded. A failed final
save can leave a saved running child or workflow. Disk artifacts provide
inspection, not per-step recovery or exactly-once execution. Atomic rename is not
a claim of power-loss durability.

After an ordinary recorded child failure, continue to the next issue if capacity
and cancellation allow. An unexpected exception after admission leaves an
unfinished child and prevents later attempts. Cancellation stops new admission and
is passed cooperatively into the active agent. Provider initialization is not
abortable; no next inference is admitted once it returns to a cancelled workflow.
The unchanged agent retains its three-step and 60-second execution bounds.

### Results and events

MCP returns a public projection omitting raw input title/body and private model
state. Each item includes index, repository/number/revision, input hash, outcome,
and the existing public child run when present. Assessment prose and quotations
remain untrusted task data. `inspect_workflow` only accesses this process's saved
records. It does not accept paths. `inspect_run` also accesses saved child records
from these workflows without another model call.

A successfully persisted `partial` or `failed` workflow is returned with MCP
`isError: false`: the tool completed the recipe and callers inspect `workflow.status`
and item outcomes. Execution/persistence errors use `isError: true`. Neither is a
retry instruction.

The [common event export](agent-discovery.md) accepts raw workflow JSON, including
through `agents events FILE.json`. Its existing v1 envelope adds optional `budget`
and `issueIndex`, and event types `workflow.budget_reserved` and `stage.unfinished`.
These are additive vocabulary extensions; older strict consumers need the current
published schema to consume workflows. Old record exports remain unchanged.

Workflow start/end events carry saved budget snapshots. Each reservation carries
its timestamp, input hash, item index, and consumed/remaining capacity. Child events
retain original run IDs while using the parent workflow ID and item index.
Unattempted items emit `stage.skipped` with a reason and no invented run ID or usage;
pending/pre-child running items emit `stage.unfinished`. Failed initialization emits
`stage.failed`. Exports remain deterministic, metadata-only snapshots.

Usage stays on child events using provider-reported values. Missing measurements
remain missing/null. The budget constrains agent invocations, not internal provider
retries, tokens, monetary cost, or subscription quota. No aggregate dollar cost or
claim of zero-cost work is inferred. Outer Codex usage remains separate.

## Rules

- Preserve existing agent responsibility, prompt, assessment schema, and bounds.
- Validate all inputs before workflow admission or capacity reservation.
- Reserve and persist before inference; failures MUST NOT refund capacity.
- Serialize workflow ownership of a shared budget and reject competing MCP work.
- Persisted child input hashes, statuses, and budget arithmetic MUST validate.
- Every supplied issue MUST remain represented in order, including unattempted work.
- Failure, cancellation, and budget exhaustion MUST NOT trigger automatic retries.
- Persistence failure MUST stop further work and MUST NOT become successful completion.

## Derived artifacts

The private workflow is the source of truth. MCP projections and common events are
derived views. [workflow-events.schema.json](../../capabilities/workflow-events.schema.json)
is generated from the executable event contract; JSON Schema does not replace
`validateReadinessWorkflow` semantic checks.

## References

- Rationale: [ADR-0007](../adr/0007-bound-a-multi-issue-readiness-workflow.md).
- Context: [composition design](../design/composable-agents.md).
- Contracts: [readiness](bug-readiness.md), [MCP](mcp-adapter.md), [events](agent-discovery.md).
- Delivery: [backlog](../plans/backlog.md), [roadmap](../plans/roadmap.md).
