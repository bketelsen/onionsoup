# 0027 — Observe Workflow owners and prove model delegation

- **Status:** Accepted
- **Date:** 2026-09-20

## Context

The first workload trial left three failed pods insufficiently evidenced because
custom controller kinds were normalized to Other. A bounded fresh owner-reference
projection identifies Argo Workflows (`argoproj.io/v1alpha1`). The MCP qualification
used a scripted client, so it did not yet establish model-selected delegation.

## Decision

Add version 2 workload evidence with one fixed `workflows.argoproj.io` projection
and verified owner API identity. Retain version 1 evidence and assessments without
reinterpretation. Workflow phase and completion time can support review of failed
executions or successful completion, never a claim about an outage, root cause or
recovery of subsequent scheduled runs. Keep unsupported controllers explicit.

Prove conversational delegation with a bounded AgentLayer consumer of the existing
stdio MCP host. The model chooses discovery, investigation, inspection and brief
composition through narrow tool contracts. The host bounds admissions, polling,
steps and elapsed time, validates returned job identities, and saves provenance.
The proof has no repair tools, generic SSH, client-selected paths or new service.

## Consequences

A fifth read increases the source deadline to 105 seconds and parent investigation
to 200 seconds. Missing Workflow resources or permission now leave v2 coverage
partial; they never become an empty successful read. Workflow completion proves
only that execution's outcome. Status can lag; unresolved failure does not prove
present application unavailability. Model prose still requires quality review.
The chat proof measures one recipe, not unrestricted conversational reliability.

## Alternatives considered

- **Read logs or full Workflow objects:** unnecessary sensitive context for the
  current-versus-historical decision.
- **Infer history from age:** discards unresolved failures without recovery evidence.
- **Build a chat service first:** deployment is premature before delegated behavior
  is exercised using the existing host and contracts.

## References

- Builds on [ADR-0026](0026-triage-workload-findings-through-bounded-evidence.md).
- Shapes [package design](../design/packages-and-recipes.md),
  [workload contract](../specs/workload-triage.md),
  [delegation proof](../specs/homelab-delegation.md), and
  [roadmap phase 26](../plans/roadmap.md#phase-26--workflow-owners-and-model-delegation).
- Upstream [Argo Workflow status fields](https://argo-workflows.readthedocs.io/en/release-3.7/fields/).
