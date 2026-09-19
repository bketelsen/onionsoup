# Plan: Investigation evidence to a draft PR

Proposed follow-through after the [P9 operator console](../specs/operator-console.md).
Implements the [change-workflow exploration](../design/investigation-to-pr.md).
Only planning is delivered here; new agents, sandbox execution and remote writes
require their own implementation phases and authority.

## Phase 1 — Read-only change proposals

- Specify one proposal contract around a frozen [investigation packet](../specs/investigation-packet.md),
  using the [artifact boundaries](../design/investigation-to-pr.md#contracts-and-provenance-before-longer-loops).
- Produce evidence-linked hypotheses, measurable acceptance criteria, scope limits
  and missing-information outcomes for a small set of existing packets.
- **Done when:** examples distinguish observed facts from guesses, reject unsupported
  repair claims, and give a maintainer a concrete scope/verification decision.
  Record assistant review separately from independent acceptance. No edits or tests.

## Phase 2 — Isolated baseline verification

- Implement the [execution policy](../design/investigation-to-pr.md#execute-under-an-explicit-host-policy)
  and host runner on an operator-owned fixture repository.
- Freeze base, environment and an approved discriminating check. Exercise resource,
  filesystem, secret and network boundaries, including dependency provisioning.
- **Done when:** the runner preserves a real assertion failure on the known base,
  distinguishes setup failure, proves denied actions stay denied, and emits bounded
  reproducible receipts without host credentials or uncontrolled repository code.

## Phase 3 — One patch candidate and independent review

- Add a scoped patch contract and [bounded review](../design/investigation-to-pr.md#bound-candidate-generation-and-review).
- Test the same reproduction on base and candidate, then selected adjacent tests;
  preserve unsuccessful attempts and inspect test integrity.
- **Done when:** one local candidate fixes the known behavior within accepted scope,
  verification refers to its exact diff/tree, independent review records meaningful
  concerns/limitations, and the operator can assess the complete evidence bundle.
  No GitHub mutation is required to prove this phase.

## Phase 4 — Explicit draft publication

- Implement the [publication boundary](../design/investigation-to-pr.md#publish-a-concrete-reviewed-result)
  for the operator-owned fixture repository, with an ADR and public contract first.
- Bind approval to concrete repository/base/head/diff/body/evidence, and test lost
  responses, duplicate requests and stale approval before live publication.
- **Done when:** one explicitly authorized draft PR matches the reviewed artifact;
  ambiguous retries reconcile to that PR rather than creating duplicates. No merge.

## Later / ideas

- Extend to one real OSS issue after fixture evidence and maintainer approval.
- Reuse the same authority/artifact pattern for homelab proposals and bounded
  maintenance, with domain-specific execution and rollback policies.
- Add more orchestrators only after public contracts survive a second consumer.

## Open questions

- Which sandbox fits this host and its threat model? Resolve before Phase 2; a
  container or worktree label alone does not establish isolation.
- Which first operator-owned fixture repository and behavior best expose failures?
- Which checks require platform/network access, and when is incomplete verification
  acceptable to a maintainer? Never let the patch worker decide its own exception.

## References

- Implements: [investigation-to-PR design](../design/investigation-to-pr.md).
- Current entry point: [operator console](../design/operator-console.md),
  [packet contract](../specs/investigation-packet.md).
- Existing rationale: [ADR-0012](../adr/0012-operate-saved-workflows-through-a-local-console.md).
- Roadmap: [backlog P10](backlog.md#phase-10--change-proposals-planned).
