---
name: operate-onionsoup
description: Diagnoses and operates the running onionsoup (daemon, work items, requests, locks, sandbox, desks, plugin). Use whenever onionsoup or an owner misbehaves, a duty does not run, something is stuck, or you need to know what the owners are doing.
---

# Operate onionsoup

Find out what the system is doing from its own records before changing anything. Done means you can name the
cause, and the fix is either applied through the normal gates or reported to the person.

## Where things are

- **Engine:** `~/projects/onionsoup`, run as the user unit `onionsoup-owners.service`, which ticks every 60s:
  re-read the configuration, refresh the state of open PRs, process requests, supervise initiatives, run due
  duties, advance runnable work items (publications and rebases), raise work notices. Duties, requests and work
  items run in the background, so the tick itself stays short; `owners tick` waits for what it started.
- **Config:** `~/.config/onionsoup` (`ONIONSOUP_CONFIG`).
- **State:** `~/.local/share/onionsoup` (`ONIONSOUP_HOME`). It holds `state/` (ledger, requests, initiatives,
  locks, ci-triage, ship), `desks/<owner>`, `checkouts/`, `evidence/<owner>` and `tools/`.
- **Initiatives:** `state/initiatives/<id>.json`, a manager's assignments to its reports. Read them with
  `npm run owners -- initiatives` and `npm run owners -- initiative <id>`; assignment state there is derived from
  the linked request and item. Only an `approved` initiative whose approval names its current `revision` dispatches.
- **Desk review rounds:** `state/desk-reviews/<owner>--<repo>.json` holds the rounds of a desk change that asked
  for changes. At the limit, `propose_changes` returns `needs-person` and hires no reviewer; after reading the diff,
  `npm run owners -- desk-review-reset <owner> [repository]` clears it.
  A step that seems stuck is usually waiting on the person to merge the previous PR, on a plan approval, or on an
  open escalation from the report.
- **Notebooks:** under state, one Git repo per owner. Read one with `npm run owners -- notebook <id>`.
- **Plugin:** `packages/owners/src/plugin.ts`, loaded by the surface's opencode (`onionsoup-surface.service`,
  http://127.0.0.1:4747). A change takes effect only when the surface restarts. The plugin, not the daemon, posts
  notices into chats and opens owner sessions (`openNeededSessions`, every 15 seconds), so both wait while the
  surface is down.

## Steps

1. Look first:
   - `systemctl --user status onionsoup-owners` and `journalctl --user -u onionsoup-owners -n 100`. `[duty]`,
     `[item]`, `[request]` and `[error]` lines say what each tick did.
   - `npm run owners -- items`, `npm run owners -- show <item>` and `npm run owners -- requests` show work and
     its gates.
   - `npm run owners -- desk-state <owner>` gives the same view as the Owner's Desk.
2. A stuck item: check its status in `show`.
   - Items waiting on the person (plan approval, push, create/delete) are not stuck; tell the person.
   - An owner's plan (`owner-change`) moves `planning` → `awaiting-plan-approval` → `working` → `landing` →
     `landed`. In `planning` a delegated item needs its planning session (`origin`, "Request <id>: ..."); in
     `awaiting-plan-approval` it waits on the person in the chat it was submitted from, or in the inbox for delegated
     work; in `working` it needs its work session (`session`, "Plan <id>: ..."), where the owner works until it
     proposes with the item; `landing` is host code publishing it. An item missing its session means the surface is
     down or the open failed: look for `owner_session_failed` in the surface's log. A chat approval lost to a surface
     restart leaves the item `awaiting-plan-approval`; ask the owner to resubmit with `item`.
   - Notices about the work go to the work session first, then the chat it came from. A `failed` item with
     `pipeline_removed` was open work of the retired freelancer pipeline; the owner plans it again if it is still
     wanted.
   - An `interrupted` item resumes with `npm run owners -- resume <item>`.
   - A `failed` item retries its stage with `npm run owners -- retry <item> [--note ...]`, or is cancelled with
     `npm run owners -- cancel <item> --reason "..."`.
   - After a crash, `recover` marks items whose runner died as interrupted so they can be resumed.
3. A runtime lock (`runtime_locked`): the daemon holds it during ticks. A stale lock is taken over
   automatically when its holder pid is gone. Never delete lock files while a daemon runs.
4. Sandbox failures show up in the command's output:
   - Tools not found: `PATH` in the unit file (node comes from mise or brew).
   - Writes denied: only the desk, `~/.cache`, `~/.npm`, `~/go` and the opencode dirs are writable.
   - Killed: memory cap.
5. Fix engine bugs with a reviewed change (the ship-onionsoup skill), not by editing the running checkout. Ship
   refuses to run over local changes.

## Pitfalls

- **Killing processes:** kill by PID. `pkill -f` patterns match the shell running them.
- **Restarting the daemon:** a manual restart interrupts items with an active runner. Shipping checks the
  full ledger first and refuses with the active item IDs and stages; wait for or resolve those items and retry.
  Once shipping proceeds, its delayed restart still has a health check and rollback.
- **Credentials:** never print values from env files (`truenas-mcp/.envrc`, `secrets/`).
