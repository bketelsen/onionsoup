# Plan: Bug and feature evidence to a draft PR

Proposed follow-through after the [P9 operator console](../specs/operator-console.md).
Implements the [change-workflow exploration](../design/investigation-to-pr.md).
Shared bug/feature scope follows [ADR-0013](../adr/0013-converge-bugs-and-features-on-a-shared-change-proposal.md).
Only planning is delivered here; new agents, sandbox execution and remote writes
require their own implementation phases and authority.

## Phase 1 — Read-only change proposals

- Specify one shared proposal contract with explicit bug and feature input variants.
  Bugs use a frozen [investigation packet](../specs/investigation-packet.md); features
  use a requirements brief and pinned source context. Both follow the [artifact boundaries](../design/investigation-to-pr.md#contracts-and-provenance-before-longer-loops).
- Produce evidence-linked hypotheses, measurable acceptance criteria, scope limits
  and missing-information outcomes for a small set of bug packets and feature briefs.
- Define the feature preparation contracts separately from existing bug readiness
  and location; start with operator-authored feature evidence if that is sufficient
  to prove the common proposal worker. Preserve `feature_request / not_applicable`.
- **Done when:** examples distinguish observed facts from guesses, reject unsupported
  repair claims and invented requirements, and give a maintainer a concrete
  scope/verification decision for both kinds. Include a clear feature, an ambiguous
  feature, a compatibility-sensitive feature, and a mixed bug/feature request.
  Record project acceptance separately from classification and information sufficiency.
  Record assistant review separately from independent acceptance. No edits or tests.

## Phase 2 — Isolated baseline verification

- Implement the [execution policy](../design/investigation-to-pr.md#execute-under-an-explicit-host-policy)
  and host runner on an operator-owned fixture repository.
- Freeze base, environment and approved bug/feature verification profiles. Exercise resource,
  filesystem, secret and network boundaries, including dependency provisioning.
- **Done when:** the runner preserves a real assertion failure on the known base,
  distinguishes setup failure, and records a feature capability gap without calling
  it a bug or treating an inapplicable base test as success. Candidate feature
  criteria and existing-behavior checks remain required. Denied actions stay denied;
  receipts retain exact environments without host credentials or uncontrolled code.

## Phase 3 — Scoped candidates and independent review

- Add a scoped patch contract and [bounded review](../design/investigation-to-pr.md#bound-candidate-generation-and-review).
- Reuse the same patch worker and review boundary for one bug and one feature.
  Apply regression checks for the bug, acceptance/compatibility checks for the
  feature, and selected adjacent tests for both. Preserve unsuccessful attempts
  and inspect test integrity.
- **Done when:** a local bug candidate and a local feature candidate each satisfy
  their accepted scope and criterion-to-evidence mapping through the shared pipeline;
  verification refers to each exact diff/tree, independent review records meaningful
  concerns/limitations, and the operator can assess the complete evidence bundle.
  No GitHub mutation is required to prove this phase. The reviewer checks migration
  and documentation obligations where the feature proposal requires them.

## Phase 4 — Explicit draft publication

- Implement the [publication boundary](../design/investigation-to-pr.md#publish-a-concrete-reviewed-result)
  for the operator-owned fixture repository, with an ADR and public contract first.
- Bind approval to concrete repository/base/head/diff/body/evidence, and test lost
  responses, duplicate requests and stale approval before live publication.
- **Done when:** an explicitly authorized draft PR matches the reviewed artifact, with request
  kind and criterion-specific verification limits accurately described;
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
- Shared direction: [ADR-0013](../adr/0013-converge-bugs-and-features-on-a-shared-change-proposal.md).
- Existing rationale: [ADR-0012](../adr/0012-operate-saved-workflows-through-a-local-console.md).
- Roadmap: [backlog P10](backlog.md#phase-10--change-proposals-planned).
