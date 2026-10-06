---
name: operate-onionsoup
description: Diagnoses and operates the running onionsoup (daemon, work items, requests, locks, sandbox, desks, plugin). Use whenever onionsoup or an owner misbehaves, a duty does not run, something is stuck, or you need to know what the owners are doing.
---

# Operate onionsoup

Find out what the system is doing from its own records before changing anything. Done means you can name the
cause, and the fix is either applied through the normal gates or reported to the person.

## Where things are

- **Engine:** the immutable release selected by the configured stable `current` pointer, run as the user
  unit `onionsoup-owners.service`, which ticks every 60s:
  re-read the configuration, refresh the state of open PRs, process requests, run due
  duties, advance runnable work items (publications and rebases), raise work notices (a merged PR is only
  journaled; landed, failed, rejected and closed-PR changes wake the owner). Duties, requests and work
  items run in the background, so the tick itself stays short; `owners tick` waits for what it started.
- **Config:** `~/.config/onionsoup` (`ONIONSOUP_CONFIG`).
- **State:** `~/.local/share/onionsoup` (`ONIONSOUP_HOME`). It holds `state/` (ledger, requests,
  reminders, locks, ci-triage, ship), `desks/<owner>`, `plans/<owner>/<item>`, `checkouts/`, `evidence/<owner>`
  and `tools/`.
- **Plan worktrees:** each approved plan (`owner-change` in `working`) has its own git worktree at
  `plans/<owner>/<item>` on branch `plan/<item>`, made from the repository's checkout at `origin/<base>` when its
  work session opens; `npm run owners -- show <item>` prints it (`Plan worktree:`), and its session runs there.
  Inspect it with `git -C <path> status` and `git -C <path> diff`, and list them all with
  `git -C <checkout> worktree list`. Proposing with the item publishes that worktree only; the owner's desk is for
  chat and direct changes. It outlives the merge (the session may still run a rollout from it): the plugin's cleanup
  pass removes it (and its branch) once the item is landed with its PR merged or closed, or cancelled, and its session
  has been idle (not busy, no update) for `PLAN_WORKTREE_LIMITS.idleBeforeRemovalHours` (24). Routine cleanup
  archives unique commits under durable local Git refs before retiring clean workspaces. Dirty or
  unreadable content remains owner maintenance with a specific reason, not a person cleanup card; ignored files go.
  Retained conversations remain archived history; never recreate their removed directory or manually remove
  a kept worktree to silence a card. A plan approved before plan worktrees existed has
  no `planWorktree` and still works on the desk.
- **Managers:** a manager's work for its reports is ordinary requests (`npm run owners -- requests`), one per report;
  `state/initiatives/` is left over from removed initiatives and nothing reads it.
- **Reminders:** `state/reminders/<id>.json` (`m-YYYYMMDD-xxxxxx`), one-off wake-ups owners set with
  `onionsoup_remind`: `pending` until `dueAt`, then `fired` with the `session` it opened (the plugin's notice timer
  opens it, so the surface must run), or `cancelled` with who and why. A pending reminder past its `dueAt` means the
  plugin is not running or its sessions fail (`reminder_session_failed` in the surface's log). Owners list and cancel
  their own; the person cancels any from the owner's page in the surface.
- **Desk review rounds:** `state/desk-reviews/<owner>--<repo>.json` holds the rounds of a desk change that asked
  for changes (`<owner>--<repo>--plans--<item>.json` for a plan's worktree). At the limit, `propose_changes` returns
  `needs-person` and hires no reviewer; after reading the diff,
  `npm run owners -- desk-review-reset <owner> [repository] [--item <plan>]` clears it.
  This is only the final publication review budget, not a per-task review/reset ceremony. Local implementation
  and local task review are permitted; delegate only when useful.
- **Operator:** optional, declared in `operator.yaml` in the config directory; the surface shows its chat at the top
  of the rail, in its own directory (default `~/projects`). It is not an owner: no owner notebook, duties or work
  items. Its commands and edits are journaled to `state/notebooks/operator/journal/*.jsonl`; read them when asked what
  it did. Its memory is `state/notebooks/operator/memory/` (`INDEX.md` plus one topic file per subject), in its
  context each turn and committed to the notebooks repo (`operator: memory: <files>`) when its chat goes idle; its
  history is `git -C state/notebooks log -- operator/memory`. As the operator yourself: approvals and ships through
  the CLI ask the person, and are theirs to decide.
- **Provider health:** `state/provider-health/<provider>.json`, written when a hire or chat fails authentication
  (`[provider] <id>: authentication failing` in the daemon's or the surface's log, a `provider-auth` inbox entry and a
  red banner in the surface). It clears itself (`status: ok`, `recoveredAt`) on the next successful call to that
  provider: the authorized person fixes credentials (`opencode auth login`, or the key reference in
  `providers.yaml`), then confirms a successful call on a declared model. Never delete health evidence
  or print envfile/key values to make the banner disappear.
- **Friction:** reports are deduplicated in `state/friction/records` and listed in the Friction rail; nothing triages them.
- **Attention:** Seen is a host-bound person action. Owners can freely acknowledge/resolve/reopen typed
  housekeeping, but cannot hide `ci_person`, `desk_review_exhausted` or ambiguous legacy human choices.
- **Wiki:** optional, declared in `wiki.yaml` in the config directory (`repository`, `branch`, `pagesDirectory`,
  `listen`, `keeper`). The clone is `<ONIONSOUP_HOME>/wiki`, made on first use; the surface serves it read-only on
  `listen` and fetches and fast-forwards it every `WIKI_LIMITS.syncMs` (5 minutes; `wiki_sync_failed` or
  `wiki_sync_diverged` in the surface's log when it cannot). Only the keeper writes, through `onionsoup_wiki`; each
  write is committed as the keeper and pushed at once, serialized by `state/locks/wiki.lock`, and journaled
  (`wiki-write`, `wiki-move`, `wiki-delete`) to the keeper's notebook. A push the remote refused is rebased and pushed
  once more; a rebase conflict aborts the rebase, keeps the keeper's commit in the clone, fails the write with
  `wiki_push_conflict`, and raises an attention item for the keeper. To resolve one: in the clone,
  `git fetch origin && git rebase origin/<branch>`, settle the conflict with the keeper's intent, `git rebase --continue`,
  then `git push origin HEAD:<branch>` (nothing is ever pushed with force). `wiki_push_failed` (network, auth) also
  keeps the commit; the next write pushes it. The move from MkDocs is one command, run once:
  `npm run owners -- wiki migrate` (nav order into `order:` frontmatter, `mkdocs.yml` deleted, committed as the keeper
  and pushed; `wiki_migration_not_needed` when there is no `mkdocs.yml`). A change to `wiki.yaml` takes effect when
  the surface restarts.
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
     work; in `working` it needs its work session (`session`, "Plan <id>: ...") and its plan worktree, where the
     owner works until it proposes with the item (an open that fails creating the worktree logs
     `owner_session_failed` with the git error); `landing` is host code publishing it. An item missing its session means the surface is
     down or the open failed: look for `owner_session_failed` in the surface's log. A chat approval lost to a surface
     restart leaves the item `awaiting-plan-approval`; ask the owner to resubmit with `item`.
   - Notices about the work go to the work session first, then the chat it came from. A `failed` item with
     `pipeline_removed` was open work of the retired freelancer pipeline; the owner plans it again if it is still
     wanted.
   - A published PR left behind its base: the `maintain-prs` duty updates only PRs GitHub reports conflicting or
     `BEHIND`, and GitHub says `BEHIND` only when branch protection requires up-to-date branches, so a stale but
     mergeable PR is journaled only with its merge state (`clean`, `blocked`). The owner brings it up to date with `onionsoup_update_prs refresh: true`
     (base merge, host verification, push without rewriting history).
   - An `interrupted` item resumes with `npm run owners -- resume <item>`.
   - `pausing` retains runner/effect/session claims until positive stopped evidence; `paused` is intentional,
     not crash recovery. Explicit Resume reuses the original unchanged goal, plan and approval. Peer messages,
     timers and notices never resume it. Do not delete locks or trust idle prose as stopping evidence.
   - Non-PR operations complete through their original request and configured host checks, supported effect
     postconditions and one final independent-family review. Missing legacy proof stays owner re-verification,
     not a fake PR or a new manual Attention-cleanup ceremony.
   - A `failed` item retries its stage with `npm run owners -- retry <item> [--note ...]`, or is cancelled with
     `npm run owners -- cancel <item> --reason "..."`.
   - After a crash, `recover` marks items whose runner died as interrupted so they can be resumed.
3. A runtime lock (`runtime_locked`): the daemon holds it during ticks. A stale lock is taken over
   automatically when its holder pid is gone. Never delete lock files while a daemon runs.
4. Sandbox failures show up in the command's output:
   - Tools not found: `PATH` in the unit file (node comes from mise or brew).
   - Writes denied: only the desk, `~/.cache`, `~/.npm`, `~/go` and the opencode dirs are writable.
   - Killed: memory cap.
5. Fix engine bugs in an isolated worktree with a reviewed PR (the ship-onionsoup skill), never by editing or
   fast-forwarding the live main checkout. Use immutable guarded releases from
   [docs/deployment.md](../../../docs/deployment.md), not the legacy checkout ship instructions.

## Pitfalls

- **Killing processes:** kill by PID. `pkill -f` patterns match the shell running them.
- **Restarting services:** arbitrary restarts can interrupt effects or cut off replies. The guarded deployment
  worker requires positive quiescence, restarts **both** owners and surface units, checks API/OpenCode/build
  health and retains a verified rollback release. Unknown leases/effects keep the guard held; only supported
  exact-receipt recovery may release them. Code rollback does not roll back state.
- **Credentials:** never print values from env files (`truenas-mcp/.envrc`, `secrets/`).
