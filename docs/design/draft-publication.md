# Owned-fixture draft publication

Living document. Rationale: [ADR-0016](../adr/0016-publish-only-approved-fixture-bundles.md).
Contracts: [draft publication](../specs/draft-publication.md).

## Overview

The deterministic publisher consumes a completed owned-fixture candidate and
produces an observed draft PR receipt. Agents never receive GitHub credentials or
publication tools. The [fixture runner](fixture-execution.md) retains its original
`publication: not_authorized`; a new bundle and authority record grant a separate,
narrow effect. Both bug and feature candidates use the same publisher.

## Design

```
verified fixture → immutable bundle → exact approval → branch → draft PR → reconciliation
```

Preparation verifies the original Git base contains only `tasks.mjs` and `README.md`,
reconstructs the reviewed diff, and creates a single local commit with that exact
parent and candidate contents. The bundle embeds fixture evidence, content hashes,
target repository identity, base/head, exact title/body, configuration revision and
a stable branch. No target code executes during publication.

CLI and local console share the same host functions. The console reads prepared
bundles from configured state, displays the diff, evidence and proposed text, and
accepts only bundle ID/digest and action. It never accepts destination or commands.
Approval lasts 24 hours and binds the entire bundle and configuration. Session
authorization can be recorded by CLI with explicit provenance. Approval records
permission to publish; human acceptance of code quality remains a separate fact.

A directory lock excludes concurrent consumers sharing the state directory.
Intent checkpoints precede remote writes. A create-only Git ref lease prevents
branch overwrite. Reconciliation checks repository identity, branch commit and
all-state PR results, including exact title/body, draft/open state and head/base
identities. A recorded PR-create intent fences every later create request. If no
matching result can be observed, the outcome remains unknown. Closed, merged,
modified, conflicting or duplicate PRs block rather than being replaced.

## Operational notes

GitHub has no transaction that locks a base through PR creation. The host checks
before effects and after creation; a racing change produces a blocked record with
any observed PR receipt preserved. The publisher does not delete or close that PR.
Checkpoints use atomic filesystem replacement; power-loss durability and restoration of stale backups are not qualified. There is no distributed lock across unrelated state roots or hosts. Use one state
root per target workflow. Stale locks require inspection and manual removal after
confirming the original process has stopped; they are never stolen automatically.

The repository must be a non-fork under `bketelsen`, pre-provisioned with each exact
fixture base commit. The publisher cannot create repositories or base branches.
The CLI uses configured `gh` authentication and SSH for a bounded Git push. No raw
transport errors or credentials are stored. A failed prepare directory remains for
inspection; do not silently regenerate a partially prepared bundle.

## References

- Rationale: [ADR-0016](../adr/0016-publish-only-approved-fixture-bundles.md).
- Contracts: [publication](../specs/draft-publication.md), [operator console](../specs/operator-console.md).
- Built in: [change workflow Phase 4](../plans/investigation-to-pr.md#phase-4--explicit-draft-publication), [roadmap](../plans/roadmap.md).
- Broader direction: [investigation to PR](investigation-to-pr.md).
