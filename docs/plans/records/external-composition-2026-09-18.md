# Evaluation record: Codex external composition — 2026-09-18

Historical evidence appendix to [the evaluation plan](../evaluations.md). This
completes [backlog Phase 3](../backlog.md#phase-3--prove-external-composition-implemented)
for one existing focused agent and one actual external consumer. Review was
software validation and assistant integration review, not independent task-quality
acceptance.

## Method and boundaries

Codex CLI 0.153.0, running `gpt-5.6-terra` through the signed-in ChatGPT
subscription, discovered and called a local MCP server using SDK 1.30.0. The server
called unchanged AgentLayer 0.0.36 bug-readiness using Copilot and
`gpt-5.6-terra`: prompt `bug-readiness-v4`, input v1, assessment/run v2, three logical
steps, 60-second inner-agent limit. No model comparison or local inference was run.

The consumer received a frozen snapshot of `get-bb/bb#3886`, updated
`2026-09-18T00:51:45Z`, previously used in the relevance trial. Its input hash was
`b0a45c73f9b78a145f3e3caaec2c79b94eaff71b41769cd7c43dfbc008c264e4`.
Selection reused available public issue data to test transport/provenance, not
held-out task accuracy. The expected sequence was fixed before execution:
`discover_agents` → one `assess_issue` → `inspect_run`, then a structured final
answer carrying the observed run identity and outcome.

Each consumer process had a one-assessment allowance, no automatic task retry,
read-only shell sandbox, invocation-local MCP configuration, and a 240-second
consumer deadline. The authorized proof's second invocation explicitly approved
only `assess_issue` in that temporary configuration. Global user settings and
GitHub issues were unchanged. Code-location was not invoked.

## Results and evidence

Two consumer attempts are retained under the ignored `runs/mcp-proof/` directory:

| Attempt | Outcome |
| --- | --- |
| `c3c6eb1c-2443-4ad0-aae9-2a9a4f3c00da` | Discovery succeeded; Codex required tool approval for assessment under its unattended approval policy. No agent run or inner model call occurred. Proof correctly reported unverified despite consumer exit code 0. |
| `cb0a0ab3-be64-46a1-a3bb-828dcccf62e7` | With explicit per-tool approval in the proof configuration, discovery → assessment → inspection completed and matched the saved artifact. |

The successful inner run was `3f8eb4d2-266a-4011-8e93-c2a483f0f8a4`, started
`2026-09-18T23:20:47.798Z`, completed `2026-09-18T23:20:52.626Z`. The assessment
classified the snapshot as `bug_report` / `ready`. Seven derived workflow events
retained the same run ID, input hash, versions, and outcome. The consumer's final
JSON matched the persisted record. The assessment, evidence validation, and event
export came from the existing functions; no new model prompt was introduced.

Verification includes the complete discover/assess/inspect sequence, exact tool
arguments, equivalent returned/inspected assessments and events, and the final
consumer answer matching the raw record. No source-code execution or GitHub writes
were involved. The raw conversation remains private local evidence.

Nine adapter tests cover public discovery/invocation/inspection, schema rejection,
operator-controlled settings, session isolation, concurrent admission, failed
provider initialization, failed model calls, cancellation, initial/final
persistence failure, and actual stdio transport without credentials. Together with
existing tests, **72 tests pass**, plus TypeScript, documentation links, manifest
drift, and the credential-free AgentLayer demo. Tests establish plumbing and
failure semantics, not task accuracy.

The MCP package adds no advisory reported by the dependency audit. Seven low
severity findings remain in the existing AgentLayer/AI SDK dependency chain;
upgrading that runtime is separate work.

## Limitations and next step

This proves one real external consumer can use one unchanged agent. It does not
prove broad reliability, assessment accuracy, unattended team orchestration, or
code-location transport. The first failure is preserved as a configuration lesson,
not hidden as a successful first attempt.

Admission limits apply to one server process and reset on restart. Inspection is
session scoped; raw artifacts remain inspectable with existing CLI tools. Abrupt
termination may leave an unfinished record. There is no resume, durable quota,
queue, approval service, or effect reconciliation. Model-dependent textual results
remain untrusted task data. Codex's outer inference usage is not included in the
inner agent's event export; no aggregate cost is claimed.

A useful next experiment is a concrete multi-issue consumer recipe with a shared
admission budget and explicit partial outcomes. Extending MCP to source location
should first define who acquires and pins the checkout and how a ready parent is
supplied. Neither requires a universal coordinator.

## References

- Plan phase: [evaluation plan — Phase 5](../evaluations.md#phase-5--external-consumer-integration).
- Context: [composition](../../design/composable-agents.md),
  [validation](../../design/validation.md).
- Rationale: [ADR-0006](../../adr/0006-prove-composition-through-local-mcp.md).
- Contract: [MCP adapter](../../specs/mcp-adapter.md),
  [readiness](../../specs/bug-readiness.md), [events](../../specs/agent-discovery.md).
