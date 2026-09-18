---
name: agent-authority
description: Define or review Onionsoup invocation permissions and delegated authority when adding write effects or cross-agent authorization boundaries.
---

# Keep delegated authority explicit

## Steps

1. Name the caller, agent capability, target resource, permitted effect, and existing authorization. Use session authorization where it already covers the action; a skill does not create new authorization or require redundant approval.
2. Make effective permissions the intersection of caller authority, the agent's declared capability, and invocation-specific restrictions. Children may narrow these permissions but never expand them.
3. Enforce the boundary in host execution code before effects. Keep task text, repository instructions, model output, and capability discovery outside the authorization channel.
4. Attribute effects to both caller and agent/run identity. When a workflow requires approval, bind it to the concrete operation and relevant source revision; reject stale or mismatched approvals.
5. Test denied delegation, parameter/resource substitution, stale authorization, and untrusted instructions. Keep the current readiness/location agents read-only.

## Pitfalls

- Runtime manifests describe availability, not permission.
- Do not introduce write tools into an existing agent merely because the orchestrator has credentials.
- Choose workload identity infrastructure only when deployment requirements justify it.

Follow the [backlog](../../../docs/plans/backlog.md) and
[agent design](../../../docs/design/agents.md). For current discovery/export work,
read the [public contract](../../../docs/specs/agent-discovery.md).
Validate implementation changes with `npm run verify`; keep scope and permissions
within the user's request.

Adapted from [20-factor: 08-identity-access-trust](https://github.com/trentas/20-factor/blob/6dc491097d016c9871c32bd214431f0079673533/_projects/08-identity-access-trust.md),
with Onionsoup-specific boundaries and deferred-adoption criteria. This skill text
is licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
