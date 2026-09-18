# Spec: Local MCP adapter, version 1

Codex is the first external consumer of this stdio adapter. The adapter calls
existing bug-readiness without changing its input, assessment, prompt, limits, or
GitHub authority. Code-location is discoverable but not invocable here.

## Interface

Launch with Node 24+, installed dependencies, and explicit environment settings:

```sh
ONIONSOUP_PROVIDER=copilot ONIONSOUP_MODEL=gpt-5.6-terra \
  ONIONSOUP_RUNS_DIR=/absolute/private/runs \
  ONIONSOUP_AUTH_PATH=/absolute/private/auth.json \
  node --import tsx src/mcp-cli.ts
```

Use the direct Node command for MCP: npm prints a header on stdout. Use absolute
paths in a consumer configuration, including the tsx loader when its working
folder differs from Onionsoup. The auth path defaults to `.local/auth.json`
relative to the launched process; explicitly configure it for external consumers.
No provider is initialized until an assessment is admitted.

| Tool | Input | Output |
| --- | --- | --- |
| `discover_agents` | `{}` | `schemaVersion: 1`, current manifests, adapter invocation availability and allowance |
| `assess_issue` | `{ issue: IssueSnapshot }` | `schemaVersion: 1`, public `run` projection, or typed adapter `error` with any saved run |
| `inspect_run` | `{ runId: UUID }` | `schemaVersion: 1`, same saved public run projection, or `run_not_found` |

All inputs are strict. Callers cannot pass provider settings, model choices,
credential paths, output paths, source checkouts, or filesystem read requests.
Discovery reports both transport-independent manifests and
`adapter.invocable: ["bug-readiness"]`; the two are not interchangeable.

A public run contains `runId`, `recordVersion`, `agent`, `promptVersion`,
`inputHash`, `issue: {repository, number, updatedAt}`, `provider`, `model`,
`status`, `startedAt`, optional `finishedAt`, optional unchanged `assessment`,
optional sanitized `failure`, and the existing `events` export. It excludes input
body/title and raw model state. Assessment text and quotations remain task data;
they are not sanitized instructions or a safe place to derive new authority.
Metadata-only event privacy remains as defined in [discovery](agent-discovery.md).

Replies include the same JSON as MCP `structuredContent` and text content.
`assess_issue` sets MCP `isError: true` for failed agent runs and adapter errors;
non-bug and needs-information assessments are successful executions. A successful
inspection has `isError: false` even when the inspected record is failed or
unfinished: consumers MUST inspect `run.status` and the event outcomes.

Adapter errors are `busy`, `invocation_limit`, `cancelled`, `run_not_found`, and
`execution_or_persistence_error`. MCP handles invalid schemas and unknown tools
as protocol/tool errors before model admission. Raw provider exceptions are never
returned. The dedicated CLI suppresses SDK warning details and replaces console
logging with a fixed diagnostic on stderr; stdout carries protocol messages only.

### Admission and persistence

`ONIONSOUP_MCP_MAX_INVOCATIONS` is an integer from 1 to 10, default 1. One process
admits at most that many valid assessment calls, with concurrency one. Busy,
invalid, already-cancelled, discovery, and inspection requests consume no allowance.
An admitted provider/configuration/persistence failure consumes its allowance.
An allowance is not a token/cost budget, a durable quota, or a provider retry count.
Launching another process resets it. The underlying agent retains its three-step,
60-second bound and provider SDK behavior.

Each process creates a UUID subdirectory under operator-selected
`ONIONSOUP_RUNS_DIR`. Admission and final records are saved via temporary-file
rename (directory mode 0700, file mode 0600). Admission persistence failure
prevents model inference. Inspection accesses only records successfully persisted
by this process, by run ID; it cannot enumerate/read older sessions or arbitrary
paths. Existing CLI event export can inspect the raw artifacts after shutdown.

Unexpected errors after admission or final persistence failure can leave only an
unfinished saved admission record. The adapter returns that state where available
and MUST NOT claim success or automatically retry. There is no per-step recovery,
resume, idempotency key, durable lookup service, or exactly-once invocation.
Cancellation and connection/process shutdown are cooperative; abrupt termination
can leave an unfinished record, which needs caller inspection.

### Codex configuration and repeatable proof

The [official Codex MCP configuration](https://developers.openai.com/codex/mcp)
supports a local command, arguments, environment, and a tool timeout. A launch
configuration uses the following shape (replace paths with local absolute paths):

```toml
[mcp_servers.onionsoup]
command = "/absolute/node"
args = ["--import", "/absolute/onionsoup/node_modules/tsx/dist/loader.mjs", "/absolute/onionsoup/src/mcp-cli.ts"]
tool_timeout_sec = 90
startup_timeout_sec = 20
required = true

[mcp_servers.onionsoup.env]
ONIONSOUP_PROVIDER = "copilot"
ONIONSOUP_MODEL = "gpt-5.6-terra"
ONIONSOUP_AUTH_PATH = "/absolute/private/auth.json"
ONIONSOUP_RUNS_DIR = "/absolute/onionsoup/runs/mcp"
ONIONSOUP_MCP_MAX_INVOCATIONS = "1"
```

The [external-consumer proof script](../../scripts/prove-codex-mcp.ts) runs a real
[noninteractive Codex consumer](https://developers.openai.com/codex/noninteractive)
with invocation-local configuration; it does not edit global Codex settings:

```sh
ONIONSOUP_PROVIDER=copilot ONIONSOUP_AUTH_PATH=/absolute/private/auth.json \
  npm run prove:codex -- /absolute/issue-snapshot.json
```

Codex must already be signed in. `ONIONSOUP_CODEX_BIN` selects a Codex executable;
`ONIONSOUP_PROOF_DIR` selects the private artifact parent. The proof fixes both
models to Terra, freezes the snapshot and expectation, admits one assessment,
explicitly approves only `assess_issue` for this authorized unattended proof,
retains the consumer transcript locally, and checks the discover/assess/inspect
sequence, exact input hash, persisted successful run, trace, and consumer-reported
identity/outcome. All attempts remain artifacts, including failure. This proves
composition for one input; it does not measure assessment accuracy or provider
cost. Recheck saved evidence without model calls with
`npm run prove:codex -- --verify runs/mcp-proof/ATTEMPT_ID`. Codex's own inference usage is separate from the inner agent's trace.

## Rules

- Agent responsibility, assessment contract, and authority MUST remain unchanged.
- Runtime configuration and artifact destinations MUST come from the operator.
- Discovery and inspection MUST NOT initialize providers or read credentials.
- Each valid admitted assessment MUST consume allowance even if it fails.
- Persistence MUST precede inference; final persistence MUST precede success.
- Unfinished/failed states MUST remain explicit; retries MUST NOT be automatic.
- The adapter MUST NOT expose GitHub mutation, target execution, or arbitrary files.

## Derived artifacts

Raw v2 readiness records remain private local artifacts. MCP projections and
workflow events are views, not independent workflow state or new assessment
versions. Transport-independent manifests retain their TypeScript entry points.

## References

- Rationale: [ADR-0006](../adr/0006-prove-composition-through-local-mcp.md).
- Context: [composition design](../design/composable-agents.md).
- Contracts: [readiness](bug-readiness.md), [discovery/events](agent-discovery.md).
- Delivery: [backlog](../plans/backlog.md), [roadmap](../plans/roadmap.md).
