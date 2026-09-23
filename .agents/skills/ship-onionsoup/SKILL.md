---
name: ship-onionsoup
description: Takes an onionsoup engine change from idea to running in production (plan, reviewed PR, merge, ship with health check and rollback). Use whenever asked to fix, change, release, deploy or ship onionsoup itself.
---

# Ship an onionsoup change

Done means the change is merged to `main`, running in `onionsoup-owners.service`, healthy, and the person has
been told if OpenChamber's opencode needs a restart.

## Steps

1. Propose. For work that needs planning, use `onionsoup_open_work`: it goes through the plan gate, the person
   approves, and freelancers implement and review.
2. Make small changes on your desk:
   - Edit on your desk (a worktree of onionsoup).
   - Run `npm run verify`, which covers the build, typecheck, tests and doc checks. Add a test in
     `packages/owners/test/` for new behaviour.
   - Update the docs the change touches: `docs/design/owners.md`, `docs/extending.md`, `docs/gaps.md`, `README.md`.
3. Call `onionsoup_propose_changes`. It verifies, has another model family review, commits, pushes and opens a
   PR. With your merge grant it merges once review passes.
4. Call `onionsoup_ship`. It fast-forwards `~/projects/onionsoup` to `origin/main`, runs `npm ci` and
   `npm run verify` in the sandbox (rolling back on failure), then restarts the daemon from a delayed systemd
   unit that checks health after 45s and rolls back if the daemon is down. Without a ship grant, the person
   approves in the chat.
5. Confirm. About a minute later:
   - `systemctl --user status onionsoup-owners` should be active on the new commit (`git -C ~/projects/onionsoup log -1`).
   - Your journal should show `shipped`, not `attention`.
6. If the change touched `plugin.ts` or anything it imports (tools, personas, the watcher), tell the person to
   restart OpenChamber's opencode. Ship cannot restart it.

## Pitfalls

- **Ship refuses:**
  - over local changes in the running checkout;
  - when it cannot fast-forward.

  Both mean someone edited it by hand; report it instead of resetting it.
- **Reviews:** a review failure is information. Fix and re-propose; never merge around it.
- **Rollback:** if the watchdog rolls back, the daemon is on the previous commit and `main` is ahead of it. Fix
  forward with a new change; don't ship the same commit again.
