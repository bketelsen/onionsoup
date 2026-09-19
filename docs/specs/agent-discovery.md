# Spec: Agent capability manifests and workflow event exports

Version 1 provides local, transport-independent discovery and inspection for the
focused agents. It does not introduce a scheduler or an authorization service.

## Interface

Capability artifacts describe input/result schemas, invocation entry points,
side effects, bounded execution, and terminal/failure outcomes. The executable
schema and limit definitions remain the source of truth; verification detects
published artifact drift.

Workflow events are a derived view of validated records, with workflow and run
identity, agent identity, sequence, timestamps, provenance, terminal status,
usage when present, and explicit reuse. Export does not invoke a model.

### Discovery commands and files

```sh
npm run agents -- list
npm run agents -- describe code-location
npm run agents -- events runs/packets/PACKET_DIRECTORY
npm run agents -- events runs/RUN.json
npm run capabilities:generate
npm run check:capabilities
```

For pure JSON stdout without npm's command header, invoke
`node --import tsx src/agents-cli.ts ...` directly. `events` accepts a raw readiness
record (v1/v2), raw location record (v1/v2/v3), packet JSON/directory (v1), or [readiness-workflow JSON](readiness-workflow.md) (v1). It also accepts [location-handoff JSON](location-handoff.md) (v1) and
[maintenance-briefing JSON](maintenance-briefing.md) (v1). It does
not accept inbox wrapper objects or a batch manifest. Output goes to stdout; it
does not rewrite the source artifact. Invalid inputs exit nonzero with a generic
message to avoid echoing untrusted content.

The checked-in [catalog](../../capabilities/catalog.json) links the
[readiness manifest](../../capabilities/bug-readiness.json),
[location manifest](../../capabilities/code-location.json), and
[event schema](../../capabilities/workflow-events.schema.json).
[capabilities.ts](../../src/capabilities.ts) derives schemas and limits from code;
`npm run verify` checks exact generated artifact drift. JSON Schema describes
shape; the named runtime validators also enforce semantic invariants.

Manifests specify existing TypeScript function entry points and required options.
The [local MCP adapter](mcp-adapter.md) exposes readiness to Codex separately;
these manifests do not expose a generic remote invocation service. A caller supplies the AI
SDK model/provider identity, persistence callback, and (for location) a matching
validated ready parent and pinned local checkout. Reading a manifest does not
initialize a provider or authorize invocation.

### Event envelope and semantics

[workflow-events.ts](../../src/workflow-events.ts) exports `workflowEvents(record)`
and executable Zod schemas. The envelope has `schemaVersion: 1`,
`kind: workflow-events`, `mode: derived-snapshot`, `workflowId`, and `events`.
Each event has a zero-based consecutive sequence, the same workflow ID, an original
record timestamp, a type, and allowlisted metadata.

- `workflow.started/completed/partial/failed/unfinished` describe the containing
  packet or standalone run.
- `agent.started/completed/failed/unfinished` preserve agent/run/parent identity,
  record and prompt versions, input hash, source commit and runtime hash when
  available. Business outcomes are separate from execution status.
- `agent.step_started/step_finished/tool_requested` project supported recorded
  events. A requested tool is not proof of successful execution. Unsupported
  historical event kinds are omitted; this is not a complete replay journal.
- `agent.reused` is a reference at packet admission time, with original timestamps
  and optional `historicalUsage`. It has no current `usage` or replayed step events.
- `stage.skipped/failed` explain ineligibility or failure before a location run
  was admitted; they never invent an agent run ID.

Sequences are causal presentation order, not a promise that clocks were globally
synchronized. Unfinished snapshots use the latest recorded event time or admission
time; export never invents a new observation time. Run IDs are the workflow ID for
standalone records; packet IDs are the workflow ID for packet exports.

Usage is provider/SDK-reported data, including any upstream normalization. Missing,
invalid, or non-finite individual measurements become null; missing usage stays
absent. The exporter cannot recover unknown values normalized to zero upstream.
Cost is not a bill or remaining subscription quota. Reuse has only historical
usage. Unknown failure strings become `unknown_failure`; only known codes are
exported. Legacy readiness remains `unclassified_legacy`, and old location records
have no invented relevance counts.

Multi-issue workflows add `workflow.budget_reserved`, `stage.unfinished`, optional
`budget` snapshots and `issueIndex`, and reasons for exhaustion/cancellation.
Child run IDs remain intact under the parent workflow ID. Existing record exports
remain unchanged; strict consumers of the extended vocabulary need the current
schema. See the [workflow contract](readiness-workflow.md) for exact admission,
partial-outcome, and persistence semantics.

Location handoffs add optional `parentWorkflowId` correlation, parent reuse, and a
code-location reservation under the same budget. See the
[handoff contract](location-handoff.md). This does not alter existing run exports.

Briefing exports compose both child workflows under a root ID. Optional
`childWorkflowId` preserves each child workflow's identity; handoff
`parentWorkflowId` still identifies its readiness predecessor. The `selection_limit`
reason marks deliberate capacity skips. Original agent IDs and historical reuse
remain intact. See [ADR-0009](../adr/0009-produce-a-bounded-maintenance-briefing.md).

The [repository brief](repository-brief.md) adds three local callable capabilities:
`repository-themes`, `repository-health`, and `maintenance-actions`. Their manifests
are included in the catalog and MCP discovery, but MCP's invocable set remains
readiness/location only. Root repository briefs and individual new agent records
support event export. Events add the three agent IDs, `submit_result`,
`no_valid_result`, `stage.completed`, optional `stageKey`, and `no_data`/`disabled`
skip reasons. Collection completion means a saved snapshot, which can contain
unavailable or partial sections; it does not establish complete source coverage.
See [ADR-0010](../adr/0010-compose-a-repository-brief-from-bounded-evidence.md).

## Rules

- Capability discovery MUST NOT initialize providers or read credentials.
- Published schemas and limits MUST agree with the current implementation.
- Capability declarations MUST NOT grant authority or broaden either agent's job.
- Events MUST preserve historical versions and failure/unknown outcomes.
- Reused runs MUST NOT appear as fresh model work or freshly incurred usage.
- Event order MUST be stable for the same input; exporting MUST NOT invent clocks,
  successful operations, unavailable usage, or task accuracy.
- Public event payloads MUST omit issue bodies, source quotations, prompts, and
  raw provider errors. Original records remain separately inspectable local data.
- These exports are snapshots, not durable step journals or resume interfaces.

## Derived artifacts

Checked-in manifests are generated from code. Workflow events are generated from
existing records and do not become an independent source of workflow truth.

## References

- Rationale: [ADR-0005](../adr/0005-test-relevance-and-portable-agent-discovery.md).
- Context: [agents](../design/agents.md), [composition](../design/composable-agents.md).
- Contracts: [readiness](bug-readiness.md), [location](code-location.md),
  [packet](investigation-packet.md).
- Delivery: [backlog](../plans/backlog.md), [roadmap](../plans/roadmap.md).

### Scheduled delivery events

[ADR-0011](../adr/0011-separate-scheduled-analysis-from-mail-delivery.md) adds derived
`brief-delivery` records from the [delivery contract](scheduled-delivery.md).
Events add `delivery.prepared/attempted/accepted/rejected/unknown/reconciled`,
`deliveryAttempt` (1–3), and `deliveryResolution` (`accepted`/`not_accepted`). The
parent workflow ID identifies the saved brief; `inputHash` identifies MIME bytes.
No recipient, SMTP host, message body, credentials or operator evidence text is
exported. A saved unfinished send exports unknown; acceptance means SMTP acceptance,
not inbox receipt. These are additive v1 event types; consumers must tolerate new
types. There is no new agent capability or MCP write tool.

### Operator action events

[ADR-0012](../adr/0012-operate-saved-workflows-through-a-local-console.md) adds
`operator-action` records from the [console contract](operator-console.md).
Derived events add `operator.requested/completed/failed/unfinished`, optional
`operatorAction` and `issueNumber`. Request identity/hash, parent brief, pinned
commit and child packet/delivery IDs provide correlation without task text,
configuration, CSRF tokens or raw failures. An unfinished action has unknown outcome;
its child records may contain meaningful completed work. See [console design](../design/operator-console.md).

### Change proposal discovery and events

[ADR-0014](../adr/0014-draft-read-only-proposals-from-frozen-evidence.md) adds
`feature-requirements` and `change-proposal` manifests and derived agent/workflow
records from the [proposal contract](change-proposal.md). Events add the
`requirements`/`proposal` stage keys, `propose` operator action and
`sufficient_for_proposal`/`proposal_ready` outcomes. The parent workflow is the
frozen packet; reservations and child run identities share one allowance. Events
omit query text, requirements, source and proposed changes. These callable
capabilities do not add new MCP invocation tools. See the
[change workflow design](../design/investigation-to-pr.md).

### Scoped patch and change-review capabilities

[ADR-0015](../adr/0015-isolate-fixture-verification-and-scoped-patches.md) adds
`scoped-patch` and `change-review` manifests. Both callable agents return structured
data; the separate [fixture runner](fixture-execution.md) owns writes and execution.
Derived traces add `verification.started/completed`, scope/receipt/tree IDs, phase and
allowlisted outcome, and patch/review stage keys. They omit source/diff text,
commands, observations and runtime paths. No MCP invocation tool or publication
capability is added. See [fixture design](../design/fixture-execution.md).

The [deterministic publisher](draft-publication.md) exports `publication.prepared`, `publication.approved`, `publication.push_intent`, `publication.branch_published`, `publication.pr_intent`, `publication.published`, `publication.unknown` and `publication.blocked`. Events add `publicationId` and allowlisted `publicationReason`; existing bundle hashes use `inputHash`, and the fixture parent uses `parentWorkflowId`. No new agent capability or model authority is introduced.

Scoped patch and change review capability version 4 advertise TypeScript and Go alternatives of the [owned-project profile](owned-project-changes.md) with input/result/run version 2 and its separate callable TypeScript exports. Their original fixture interfaces remain version 1. The new `clippy-bubble-color-v1` profile shares the same workers and adds profile-specific host verification under [ADR-0018](../adr/0018-separate-project-policy-from-language-verification.md). No additional agent responsibility or GitHub tool is introduced. Common project events preserve parent request/job identities and two implementation reservations; proposal preparation remains a separately budgeted parent.

The `repository-task-v1` profile carries accepted job v2 inside the existing worker v2 envelope; see the [repository-profile contract](repository-profiles.md). It shares the same callable workers and effects.
