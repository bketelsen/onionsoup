# 0017 — Execute one accepted owned-project proposal

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

Fixture patches and publication are proven on two tiny tasks. The next authorized
trial is publication-status filtering in Onionsoup itself, starting from a model
proposal rather than a hand-authored fixture scope. The operator authorized the
implementation and an owned-repository draft; no merge or third-party writes.

## Decision

Add one explicit `onionsoup-publication-filter-v1` project profile. Existing
requirements/proposal workers produce a read-only proposal from an operator request
and pinned source. A separate acceptance artifact binds its exact result, base,
allowed files, check-to-criterion mapping, source context, dependency lock and
execution profile, recording assistant acceptance under explicit session authority.
Unknown or unresolved proposals cannot enter execution.

Use the scoped-patch/change-review responsibilities with version-2 project inputs;
retain the version-1 fixture APIs and records. Agents only submit structured results.
Host code applies allowed text replacements and runs fixed checks. Provision npm
lockfile dependencies separately with scripts disabled and no host credentials;
execute candidate code in a rootless network-disabled container with read-only
source/dependencies/runtime and bounded temporary space, time and output.

Publish a version-2 project bundle through the same approval/reconciliation engine.
Pin the exact repository/base/head and evidence. Preserve version-1 fixture bundles.
Only `bketelsen/onionsoup` and this profile are qualified initially. No generic shell
configuration, dependency edits, test weakening, automatic repair loop or merge.

## Consequences

The feature remains a separate draft PR; pipeline infrastructure can land on main.
The trial qualifies a limited project profile, not arbitrary repositories or hostile
multi-tenant code. Finite black-box checks and model review are not human acceptance.
Verification input seeds and exact runtime/dependency identities remain local evidence.

## Alternatives considered

- **Hand-author the feature patch:** would not prove the proposal-to-patch handoff.
- **Give an agent a terminal:** would collapse execution and scope authority.
- **Build a general repository runner:** postpone until this narrower profile is useful.

## References

- Builds on: [ADR-0014](0014-draft-read-only-proposals-from-frozen-evidence.md), [ADR-0015](0015-isolate-fixture-verification-and-scoped-patches.md), [ADR-0016](0016-publish-only-approved-fixture-bundles.md).
- Shapes: [design](../design/owned-project-changes.md), [contract](../specs/owned-project-changes.md).
- Implements: [change workflow plan](../plans/investigation-to-pr.md).
