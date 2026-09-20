# 0026 — Triage workload findings through bounded evidence

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

The first homelab brief reports failed pods alongside healthy Argo applications.
Counts alone cannot distinguish historical failures from current workload problems.
The owner authorized a focused triage agent, evidence collection, brief integration
and bounded MCP delegation, retaining read-only operation.

## Decision

Project pod lifecycle/container status and Job/ReplicaSet/Deployment scalar status
through four fixed SSH reads. Join owners by UID and namespace, never guessed names.
Keep resource names in a private local lookup only; supply pseudonymous IDs and
normalized enums/counts/times to Terra. Select at most ten candidate pods with an
explicit denominator and omissions. Missing data remains unknown.

A single AgentLayer agent classifies every selected candidate as attention now,
historical, or insufficient evidence, with citations and a bounded next investigation.
Host validation requires evidence of recovery before historical classification.
Neither a valid citation nor these conservative gates establishes semantic accuracy.
The agent has only a result submission tool, no infrastructure access.

Compose completed or failed triage records into saved briefs. A separate stdio MCP
host admits investigations for configured targets and builds saved-source briefs.
Clients select target/job IDs, not host paths, commands, credentials or providers.
Persist admission before effects; one active job and a finite per-process admission
allowance; inspection survives restart without replay. No service mutation.

## Consequences

The same collector, agent and recipe work through CLI and MCP. Homelab model input
is minimized but does leave the machine through the configured subscription.
Controller status is not an atomic snapshot or proof of application behavior.
Unsupported controllers, missing UIDs and stale status limit classification. Logs,
events, free-form error messages and automatic remediation remain separate work.

## Alternatives considered

- **Treat every failed pod as an incident:** confuses retained history with current failures.
- **Infer recovery from age or name prefixes:** lacks owner identity and readiness evidence.
- **Give the agent kubectl/log access:** expands authority and private context unnecessarily.

## References

- Builds on: [ADR-0025](0025-compose-k3s-and-gitops-observations.md),
  [ADR-0022](0022-package-capabilities-with-thin-host-applications.md).
- Shapes: [workload triage contract](../specs/workload-triage.md),
  [package design](../design/packages-and-recipes.md),
  [roadmap](../plans/roadmap.md#phase-25--workload-triage-and-homelab-mcp).
