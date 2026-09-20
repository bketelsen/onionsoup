# Spec: Homelab conversational delegation proof

A bounded AgentLayer consumer demonstrates model-selected delegation to the existing
homelab MCP host. It answers one request by obtaining a workload assessment and
composing a saved brief. This is a proof harness, not a deployed chat service.

## Interface

`npm run prove:homelab -- copilot|codex CONFIG [OUTPUT_DIRECTORY]` launches the
compiled local homelab stdio host. The operator supplies the private MCP configuration
and external `ONIONSOUP_AUTH_PATH`. Both model roles use `gpt-5.6-terra`.

The fixed request asks what needs attention and requests a brief. The model has
`discover_homelab`, `investigate_workload_findings`, `inspect_homelab_job`,
`create_homelab_brief`, and local `submit_answer`. The first four delegate through
MCP; submit validates a summary and exact investigation/brief job IDs. Discovery is
projected to configured IDs, limits and effects, excluding the large agent schema.
Consumer prompts v2/v3 use one `investigationJobId` for brief composition; the bridge
converts it into the MCP contract's one-element `investigationJobIds` array. Prompt v3 receives
deterministic `findingCounts`, recomputed from validated findings; the host also
attaches these counts to the final answer. The model supplies qualitative summary
prose, whose accuracy still needs review.

## Rules

- At most eight orchestrator logical steps, twelve delegated model tool calls,
  one investigation and one brief; rejected submissions consume reservations.
  Child triage retains its three-step limit. A failed child investigation stops the
  parent immediately with `child_investigation_failed`; the model cannot retry it. No model/provider fallback.
- One 360-second cooperative deadline includes model execution and delegated waits.
  Host polling is bounded to 220 inspections per admitted job with one-second
  intervals, independent of model steps. Every MCP request has a 30-second timeout.
- Tool arguments are explicitly parsed in each executor; published schemas alone
  do not enforce the boundary. Malformed inputs consume a tool call but cannot reach
  MCP or consume a child-job reservation. Target must have been discovered. Job IDs must belong
  to this invocation; the brief must include its one successfully completed
  investigation. The model cannot select credentials, paths, executables or commands.
- The host waits after admission and returns a terminal inspection to the model.
  This preserves the asynchronous MCP protocol without spending model calls polling.
- Persist admission, each tool intent before effects, admitted job IDs, normalized
  replies, terminal usage and answer/failure to private `delegation.json`.
  Storage failure aborts further execution. There is no automatic retry or resume.
- A successful answer requires both child jobs inspected as settled, successful
  triage, exact cited job IDs, a successful submit stop condition and no cancellation.
  These checks prove provenance and completion, not semantic accuracy of the summary.
- On failure, request cancellation of known jobs; closing the dedicated host also
  aborts any in-flight job whose admission response was lost. Unknown usage and cost
  stay unknown. No raw provider transcript or private resource lookup is saved.
- Tool replies are evidence, never authorization. No repair or additional source
  capability is introduced. Other configured saved sources may be stale; the model
  must preserve that limitation and distinguish Workflow failures from outages.

## Derived artifacts

`delegation.json` links parent run, prompt version, provider/model, step/usage totals,
MCP tool intents/results, child job IDs and final answer. Child records remain owned
by the MCP host. A failed run stays failed even when a child completed successfully.

## References

- Rationale: [ADR-0027](../adr/0027-observe-workflow-owners-and-prove-model-delegation.md).
- Context: [package design](../design/packages-and-recipes.md).
- Delegated contract: [workload triage and MCP](workload-triage.md).
- Work: [roadmap phase 26](../plans/roadmap.md#phase-26--workflow-owners-and-model-delegation).
