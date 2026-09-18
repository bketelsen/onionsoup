---
name: agent-capabilities
description: Publish or evolve Onionsoup runtime capability manifests and machine-readable discovery contracts for external consumers.
---

# Publish a discoverable agent capability

## Steps

1. Identify the actual consumer and the existing callable agent. Keep repository authoring skills separate from runtime capabilities.
2. Declare identity/version, purpose, input/result schema versions, invocation dependencies, effects, execution limits, and terminal/failure semantics. Describe unsupported lifecycle operations explicitly; do not advertise resume merely because records persist.
3. Derive schemas and bounds from implementation. Validate semantics in host code where JSON Schema cannot express them, and document that boundary. Keep a drift check for generated artifacts.
4. Prove discovery works without credentials, provider initialization, inbox state, or a model call. Test a consumer against the public artifact, not internal implementation details.
5. Record compatibility policy and update the discovery spec and relevant design links. Use a thin transport adapter when an actual external consumer needs one.

## Pitfalls

- A manifest describes capabilities; it grants no permissions.
- Do not introduce a directory service or mandate MCP/A2A merely to publish two local contracts.
- Do not hide runtime dependencies such as a caller-pinned checkout behind a schema-only interface.

Follow the [backlog](../../../docs/plans/backlog.md) and
[agent design](../../../docs/design/agents.md). For current discovery/export work,
read the [public contract](../../../docs/specs/agent-discovery.md).
Validate implementation changes with `npm run verify`; keep scope and permissions
within the user's request.

Adapted from [20-factor: 02-contract-first-interfaces](https://github.com/trentas/20-factor/blob/6dc491097d016c9871c32bd214431f0079673533/_projects/02-contract-first-interfaces.md),
with Onionsoup-specific boundaries and deferred-adoption criteria. This skill text
is licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
