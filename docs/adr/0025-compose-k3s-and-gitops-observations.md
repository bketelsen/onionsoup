# 0025 — Compose k3s and GitOps observations

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

The owner wants k3s and Argo CD on a configured compute host included in a homelab
brief. Container process states cannot describe Kubernetes readiness or GitOps
sync. Existing sources already produce sanitized observations with provenance.

## Decision

Add a separate deterministic Kubernetes source with three fixed status projections:
node Ready conditions, pod phases/Ready conditions, and Argo CD Application health
and sync status. Query the host's k3s system kubeconfig, default context and loopback
API endpoint over bounded SSH. Keep credentials on the host. Direct access is the
default; an explicit operator configuration may enable noninteractive sudo only
for these fixed k3s get commands. This does not change the container source's
no-sudo contract. Never sync, refresh, patch, exec or read Secrets.

Share the SSH process bounds in the runtime package. Compose saved TrueNAS,
container and Kubernetes observations with a separate pure brief function. Include
source hashes, run identities, observation times, missing coverage and freshness;
never collapse these distinct signals into a generic health score. No LLM is needed.

## Consequences

This works without an Argo CLI or another network endpoint. Kubernetes and Argo
queries span the configured cluster and visible namespaces, not just the SSH host.
K3s admin credentials and the SSH account may have broader authority than these
commands; a dedicated RBAC identity is a later hardening step. The three reads are
not an atomic snapshot. Saved briefs do not refresh observations or authorize repair.

## Alternatives considered

- **Use container inventory as cluster health:** lacks readiness and sync evidence.
- **Give a model kubectl or SSH:** unnecessary authority for deterministic counts.
- **Read complete JSON objects locally:** transfers specs and private metadata that
  these summaries do not need. Project status fields remotely instead.

## References

- Builds on: [ADR-0024](0024-collect-container-inventory-over-bounded-ssh.md),
  [ADR-0023](0023-collect-read-only-truenas-evidence-through-existing-mcp.md).
- Shapes: [package design](../design/packages-and-recipes.md),
  [Kubernetes and homelab brief contract](../specs/homelab-brief.md),
  [roadmap phase 24](../plans/roadmap.md#phase-24--k3s-gitops-and-a-homelab-brief).
