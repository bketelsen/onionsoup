# Spec: Saved readiness to pinned code-location handoff, version 1

This recipe lets an external consumer select a saved ready assessment for the
existing code-location agent. The host owns snapshots and source configuration;
both agents draw from the same process allowance. No agent changes responsibility.

## Interface

`locateReadyIssue(parent, options)` in [location-handoff.ts](../../src/location-handoff.ts)
accepts a validated completed v2 readiness record for a `bug_report` with readiness
`ready`. Options provide a shared budget, explicit model factory, persistence
callback, optional abort signal and parent workflow ID, and operator-owned source:
`{ checkout, repository: { name, commit } }`. Commit is a full 40-character SHA.

The [MCP adapter](mcp-adapter.md) optionally reads all three launch settings:

```sh
ONIONSOUP_SOURCE_CHECKOUT=/absolute/local/checkout
ONIONSOUP_SOURCE_REPOSITORY=get-bb/bb
ONIONSOUP_SOURCE_COMMIT=3a4288bd0f34f888a5eb43f1099f7b60fe86eea4
```

Without source configuration the new tools are absent. Partial configuration is a
startup error. Discovery exposes repository/commit and availability, not checkout
paths or source contents; discovery does not inspect Git or initialize providers.
The operator acquires the checkout separately. No clone, fetch, worktree checkout,
source execution, or GitHub mutation is performed by the recipe.

| Tool | Input | Result |
| --- | --- | --- |
| `locate_ready_issue` | `{ readinessRunId: UUID }` | Saved public `handoff` and current shared `budget` |
| `inspect_handoff` | `{ workflowId: UUID }` | Same saved projection and current shared budget; no provider access |

Inputs are strict. The caller cannot provide checkout paths, source revisions,
issue content, parent summaries, provider settings, or permission changes. The run
must have been saved in this process, by a single call or readiness workflow.
Unknown runs, ineligible assessments, and repository mismatches are rejected
before budget reservation. MCP serializes handoffs with all other model work.
A caller using the direct function must likewise serialize shared budget ownership.

The host constructs existing `LocationInput` v1 using the saved parent's exact
snapshot, hash, run ID, prompt version, and summary. The unchanged source adapter
checks checkout origin and commit and reads pinned Git blobs, ignoring working-tree
changes. Its per-run source/step/time limits and citation validator still apply.
An unavailable or mismatched checkout can fail after reservation but before model
inference; no fake child run is created if location admission never occurred.

### Saved record and outcomes

A private `location-handoff` record contains `schemaVersion: 1`, `workflowId`,
optional `readinessWorkflowId`, `startedAt`, optional `finishedAt`, `status`,
`readiness`, pinned `repository`, `budgetAtStart`, `budget`, optional `reservation`
and `reservedAt`, `disposition`, optional `reason`, and optional `location`.
The reused readiness and new location are the original agent records.

| Status / disposition | Meaning |
| --- | --- |
| `running` / `pending` | Last persisted snapshot is unfinished, even if its child already completed |
| `completed` / `located` | Location returned a validated brief with code pointers |
| `partial` / `not_located` | Location completed without establishing a location |
| `partial` / `not_attempted` | No location reservation or run; reason `budget_exhausted` or `cancelled` |
| `partial` / `unfinished` | Unexpected error after child admission; saved child is running, reason `execution_error` |
| `failed` / `failed` | Pre-child execution/configuration error, recorded agent failure, or cancellation after reservation |

Failure reasons are `execution_error`, `agent_failed`, or `cancelled`. A failed
pre-child attempt has a reservation but no child run. No task retries are automatic.
A terminal failed or partial handoff is a successfully recorded workflow outcome,
so MCP returns `isError: false`; the consumer MUST inspect status and disposition.
Unexpected execution/persistence errors return `isError: true` and the last saved
handoff if available, never unsaved success or raw exception text.

### Persistence, budgets, and observability

Save the initial handoff, reservation, child admission/final snapshots, and final
handoff. Each save is awaited; persistence errors stop work. The last successfully
saved snapshot remains the only inspectable workflow state. A reservation whose
save fails is still consumed in memory. As with readiness workflows, restart
resets process capacity, and snapshots do not implement resume or durable quotas.

One location invocation consumes one shared slot, including internal phases and
ordinary failures. Reusing readiness consumes no new slot. Cancellation is
cooperative; source/model calls retain the existing location deadline. Provider
initialization cannot itself be interrupted, but no child is started after it
returns to a cancelled handoff. Allow at least the location deadline plus overhead
for the consumer tool timeout.

MCP writes `handoff-WORKFLOW_ID.json` under its private session directory, embedding
the parent and child records. The public projection omits raw issue bodies, model
conversation, source activity logs, and unrelated excerpts. It includes the
assessment and brief, whose prose/quotes remain untrusted data, plus source and
run identities, budget snapshots, and common events. `inspect_handoff` supports
only saved handoffs in this process; existing CLI export can inspect raw files
later.

[Common events](agent-discovery.md) show the parent as `agent.reused` with historical
usage only, one location reservation if admitted, new child events, or an explicit
skipped/failed/unfinished stage. Optional `parentWorkflowId` links back to the
readiness workflow on each event when known. Child `parentRunId`, input hash, pinned
commit, runtime hash, and actual outcome remain visible. No new readiness usage or
successful location is inferred from a reused parent. Event v1 gains this optional
correlation field; old record exports remain unchanged.

## Rules

- Readiness and location inputs/results/prompts MUST remain unchanged.
- Select parent and source through host-owned identities, not model-reconstructed evidence.
- Validate parent eligibility/repository identity before reservation.
- Persist reservation before new inference and preserve source/citation validation.
- Single calls, readiness workflows, and handoffs MUST share one allowance.
- Do not invent a child run ID, usage, citation, or successful result for skipped work.
- Persistence failure MUST stop execution and expose only saved state.
- Locations remain investigation leads, not diagnoses, fixes, or measured test coverage.

## Derived artifacts

MCP projections and event exports are views of the saved handoff. Existing packet
v1, readiness-workflow v1, readiness v2, and location v3 records remain readable and
unchanged. `validateLocationHandoff` checks parent/child identity and budget/outcome
consistency; existing agent validators enforce their own result invariants.

## References

- Rationale: [ADR-0008](../adr/0008-handoff-ready-assessments-to-pinned-source-location.md).
- Context: [composition](../design/composable-agents.md).
- Contracts: [MCP](mcp-adapter.md), [readiness workflow](readiness-workflow.md),
  [code-location](code-location.md), [events](agent-discovery.md).
- Delivery: [backlog](../plans/backlog.md), [roadmap](../plans/roadmap.md).
