# Spec: Agent capability manifests and workflow event exports

Version 1 provides local, transport-independent discovery and inspection for the
two focused agents. It does not introduce a scheduler or an authorization service.

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
record (v1/v2), raw location record (v1/v2/v3), or packet JSON/directory (v1). It does
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
They do not expose a generic remote invocation service. A caller supplies the AI
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
