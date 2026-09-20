# Evaluation record: Read-only TrueNAS first contact — 2026-09-19

Historical evidence appendix to [the evaluation plan](../evaluations.md), phase 20.
Assistant-run transport and acquisition qualification; no model-quality evaluation.

## Method and boundaries

The owner supplied a local TrueNAS MCP checkout, its existing external credential
configuration, a single NAS endpoint and permission for self-signed TLS. The checkout
was at `835a43a`; the existing executable reported version 0.1.0. Onionsoup used that
binary without modifying the server checkout. Each saved observation records the
actual executable digest; a checkout revision alone does not establish binary provenance.

First inspected the local CLI and health-tool implementation, then performed a
bounded MCP probe. Forced read-only flags and environment settings, verified all
18 discovered tools against the inspected catalog and called the health report.
The Onionsoup CLI repeated this acquisition through the reusable adapter and saved
a sanitized record. Credentials were loaded without printing their values; real
hostnames, addresses, topology and resource identifiers are excluded from this report.

## Results and evidence

Both live observations succeeded. The packaged adapter received usable evidence
for all five sections and completed with `no_flags_observed`. Local evidence retains
counts and severity coverage; no raw NAS payload was sent to a model or checked in.
The configured certificate exception applied only to the existing server process.

Nine focused tests cover count-only normalization, unknown/malformed sections,
severity handling beyond the upstream summary, forced read-only/TLS flags,
parameter substitution, real MCP stdio exchange, catalog denial before tool calls,
secret-bearing stderr/error suppression, partial results, cancellation and admission
failure. Synthetic inputs replace private observations in the test suite.

The standalone repository-brief release was installed and exercised after adding
this independent domain. Its selected dependency closure excludes the homelab app
and TrueNAS adapter, preserving the previous portable-release boundary.

The first full regression run exposed a legacy sandbox test following current HEAD
while using a frozen registry-only dependency snapshot. Workspace extraction changed
the current lock identity, and the sandbox correctly rejected it. The historical
baseline test now pins its original qualified commit and keeps digest checks intact;
this does not qualify repair execution against a workspace dependency tree.

Final `npm run verify` passed: **216 tests, 216 passed, zero skipped**, including
the existing Go/Node/fixture sandbox checks and the independently installed compiled
release. Documentation checks covered 93 indexed documents, 13 skills and five
instruction symlinks; dependency checks covered 12 workspaces. The live observation
artifact was confirmed mode 0600. No server-project changes were made.

## Limitations and next step

This is one server and one point-in-time observation. The aggregate report makes
sequential upstream reads, not a transactional or continuous health assessment.
Disk counts do not establish disk health; dismissed alerts remain part of reported
counts. Unknown evidence is preserved. TLS verification was intentionally disabled
for the configured NAS; certificate pinning/custom CA trust is not implemented.
The adapter trusts the configured local binary; it does not sandbox an adversarial
server. A malformed or secret-bearing upstream diagnostic is never copied into the
saved record, but the credential remains available to its authorized child process.

Next add another bounded evidence source or a focused interpretation contract over
these observations. No Incus, Podman, Docker or Synology access has been configured;
service mutation and generic homelab orchestration remain deferred.

## References

- Plan phase: [evaluation phase 20](../evaluations.md#phase-20--read-only-truenas-first-contact),
  [roadmap phase 22](../roadmap.md#phase-22--read-only-truenas-evidence).
- Rationale: [ADR-0023](../../adr/0023-collect-read-only-truenas-evidence-through-existing-mcp.md).
- Context: [package design](../../design/packages-and-recipes.md).
- Contract: [TrueNAS evidence](../../specs/truenas-evidence.md).
