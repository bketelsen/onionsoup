# Evaluation record: Two-agent handoff — 2026-09-18

Evidence appendix to [the evaluation plan](../evaluations.md), completing
[follow-through Phase 5](../backlog.md#phase-5--two-agent-handoff-under-shared-admission).
This is assistant integration review and exact-source verification, not independent
maintainer acceptance or a new task-accuracy estimate.

## Method and boundaries

Use the same frozen public `get-bb/bb#3886` snapshot as prior composition trials,
loaded once as host-prepared input. Its SHA-256 is
`b0a45c73f9b78a145f3e3caaec2c79b94eaff71b41769cd7c43dfbc008c264e4`.
The host supplies the existing local checkout and pinned source commit
`3a4288bd0f34f888a5eb43f1099f7b60fe86eea4`. The consumer may select only the saved
readiness run ID; it cannot reconstruct the parent or choose a source path.

Codex CLI 0.153.0 uses `gpt-5.6-terra` on the signed-in ChatGPT subscription.
Both inner agents use Copilot `gpt-5.6-terra`, AgentLayer 0.0.36, unchanged
readiness prompt `bug-readiness-v4` and location prompt `code-location-v7`.
Readiness input/result are v1/v2; location input/result are v1/v3; handoff is v1.
The source runtime hash is
`b52c41380f58cc540f69a2b90e07d841499e1fc9a1689f84ff70ebd5c34cce6d`.

The expected sequence was discovery → prepared readiness → location by saved parent
ID → handoff inspection. The process allowance was two invocations total, with
existing per-agent limits. Consumer tool timeout was 220 seconds and overall
consumer deadline 480 seconds. No automatic retry, source fetching, target code
execution, GitHub writes, new model comparisons, or local inference was performed.

## Results and evidence

One live consumer attempt passed:
`runs/mcp-proof/80f84092-ce4d-4cf1-9af2-e0dd1b12271d` (ignored local artifacts).
The report date is local time; the following original timestamps are UTC.

| Artifact | Identity/outcome |
| --- | --- |
| Readiness workflow | `0561fcd9-e8a7-4a47-be56-8085e7fc8d9d` |
| Readiness run | `cae38fb7-7c9d-4a1a-af1c-b4fadbb3cfbb`; completed, ready bug |
| Location handoff | `789a3306-5dc7-4695-bbfa-dd70f376ac7e`; completed |
| Location run | `6b6b282a-0031-4ea6-b8db-754d072637fe`; completed, located |
| Handoff time | `2026-09-19T00:12:21.118Z` to `2026-09-19T00:12:45.762Z` |
| Admission | limit 2, consumed 2, remaining 0 |

The proof verified exact issue preservation, saved parent equality, parent workflow
and run references, source commit, returned/inspected brief equality, and the
consumer's final structured answer. Thirty-four handoff events retain correlation,
show readiness as historical reuse, and show only location as fresh work within
the handoff. The preceding readiness workflow accounts for the first invocation.

Location used nine logical steps and seven source inspections. All four quotations
were independently matched against Git blobs at the pinned commit:

| Evidence | Source window | Meaning/limit |
| --- | --- | --- |
| Code | `apps/server/src/services/threads/title-generation.ts:49–73` | Eligibility and word-count entry point |
| Code | Same file, `133–156` | Fallback and early `too-short` return path |
| Test | `apps/server/test/threads/title-generation.test.ts:17–43` | Word boundary and text aggregation; model labels **adjacent** because helper inputs have empty mentions |
| Test | Same file, `58–63` | Fallback/eligibility assertion; **adjacent**, without command mentions or sidebar rendering |

The model reports completed bounded test search, while explicitly stating that it
found no command-mention eligibility assertion. It also notes the pinned commit
differs from the report's cited revision and that provisioning, stored titles, and
UI fallback were not traced. Exact quotations establish grounding, not diagnosis
or sufficient regression coverage.

Seven new tests exercise parent/source mismatch, unknown/forged source arguments,
shared exhaustion, cancellation, source unavailability before inference,
not-located versus failed child results, persistence boundaries, and MCP composition
through saved IDs. **93 tests pass**, together with types, documentation links,
manifest drift, and the credential-free AgentLayer demo. Prior single-agent and
multi-issue proof artifacts remain verifiable without new model calls.

## Limitations and next step

One existing report demonstrates integration, not broad quality or reliability.
The host still acquires the checkout, and inspection/reuse is process scoped.
Budget resets on restart; no durable quota, resume, task retry, or write authority
was added. Provider/SDK usage and subscription costs retain their existing unknowns;
outer Codex usage is separate.

The [roadmap's broader vision](../roadmap.md#broader-vision--domain-focused-agent-teams)
now records that OSS is the first application, with homelab maintenance a potential
future domain. A next team should begin with one useful, separately authorized
bounded job, such as assessing supplied backup or service-health evidence, and
reuse the demonstrated contract/budget/observability pattern.

## References

- Plan phase: [evaluation plan — Phase 7](../evaluations.md#phase-7--two-agent-external-handoff).
- Rationale: [ADR-0008](../../adr/0008-handoff-ready-assessments-to-pinned-source-location.md).
- Context: [composition](../../design/composable-agents.md), [validation](../../design/validation.md).
- Contracts: [handoff](../../specs/location-handoff.md), [MCP](../../specs/mcp-adapter.md),
  [source location](../../specs/code-location.md), [events](../../specs/agent-discovery.md).
