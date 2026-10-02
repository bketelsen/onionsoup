---
name: ship-onionsoup
description: Takes an onionsoup engine change from idea to running in production (plan, reviewed PR, merge, guarded release with health check and rollback). Use whenever asked to fix, change, release, deploy or ship onionsoup itself.
---

# Ship an onionsoup change

Work in an isolated development worktree. Never edit, fast-forward or rebuild a live checkout.
Implementation/publication and production rollout may have different owners: a delegated implementation
ends at its authorized merge and hands the tested commit to the rollout coordinator.

## Implementation and publication

1. Use the original approved goal, acceptance criteria and work item. Replies, retries, PR maintenance and
   unchanged resumptions reuse the recorded approval and applicable standing grants. New scope and genuine
   creates/deletes or destructive effects retain their existing gates; chat prose supplies no authority.
2. Implement locally or delegate bounded tasks when useful. Local task review and reviewer dispatch are
   optional; neither substitutes for the one final required independent-family publication review.
   Owner workspaces allow ordinary local edits/development without repeated prompts, while declared denies
   and host world-effect gates still apply. Chat bash remains unsandboxed; convenience rules are not a boundary.
3. Run targeted regressions and `npm run verify`; update directly related living documentation.
   The test runner defaults to four Node test files concurrently in the actual child argv. Override with
   `ONIONSOUP_TEST_CONCURRENCY` or `--test-concurrency`; do not put that flag in `NODE_OPTIONS`.
   Go integration checks use the configured `ONIONSOUP_HOST_GO_ROOT`, not an arbitrary PATH version.
4. Owner publication uses `onionsoup_propose_changes { item }`: host sandbox verification, final cross-family
   review, then durable commit/push/PR checkpoints and configured merge gates. Fix real review blockers; do
   not reset review history merely to retry. Only a truly exhausted final review budget needs the existing
   person decision. App-native implementation sessions use their authorized PR workflow instead.
5. Merge only the exact tested/reviewed head after required CI is green and blocking reviews are clear.
   Report the PR, merged commit, evidence and remaining operational unknowns to the rollout owner.

## Production rollout

[docs/deployment.md](../../../docs/deployment.md) and `scripts/deploy-release.mjs` are canonical for
onionsoup deployment, superseding the legacy checkout-based `onionsoup_ship` procedure.

The authorized operator stages the exact merged commit as a new immutable release with matching dependencies,
assets and release manifest, using the separate stable deployment worker. Guarded rollout drains admitted
work, requires positive quiet/lease/session evidence, records rollback, atomically switches `current`,
and restarts **both** `onionsoup-owners.service` and `onionsoup-surface.service`. The surface's OpenCode
must load the plugin through the stable release pointer. Check both services, authenticated OpenCode health,
surface behavior and the reported build ID; an active systemd process alone is not readiness or plugin attestation.

Do not clear locks, admissions, notices or drain/quarantine records to make rollout proceed. Unknown effects
stay held; use only the documented exact-receipt recovery procedure when applicable.
Rollback switches to the retained verified release, restarts both units and verifies it. Failed rollback
keeps the guard held. A code-pointer rollback does not roll back state or configuration; preserve their backups
and handle any incompatibility explicitly. Never delete the old release.
