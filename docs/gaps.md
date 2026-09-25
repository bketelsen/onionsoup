# Gaps

What onionsoup cannot do yet, most important first. Owners (Leto in particular) should shrink this list.

## Owners and their authority

- **Owner sessions' bash is not sandboxed yet.** Owner chats and the sessions that carry out approved plans run in
  the surface's opencode on the host, and so do the implementer and reviewer subagents they start. Their bash runs
  as the person, bounded only by permission rules, which [AGENTS.md](../AGENTS.md) rule 3 says are never the
  boundary. The follow-up is to run chat bash through bwrap from a `tool.execute.before` wrapper in the plugin, the
  same sandbox hires and verification already use.
- **The operator is unsandboxed and trusted.** It runs as the person with nearly every permission; its only brakes
  are `OPERATOR_ASK_BASH`, its prompt and the audit journal. Chat shells get the surface opencode's own credentials
  blanked (`hideHostCredentials`, the `shell.env` hook), so a command cannot answer other sessions' prompts through the
  API, but a prompt injection can still do anything the person's account and the CLI can. Its journal has no view in
  the surface yet: read
  `state/notebooks/operator/journal/*.jsonl`.
- **Plan approvals in chat do not survive a restart.** A plan approval pending in a chat is lost if the surface restarts (the
  permission prompt lives in its opencode); the item stays `awaiting-plan-approval` and the owner resubmits it with
  `item`.
- **Desk changes need a first real run.** `onionsoup_propose_changes` (verify → cross-family review → commit →
  push → PR → merge under a `merge` grant → publish if the owner is a site source) is built, and Bellonda holds a
  merge grant for her wiki, but it has not yet run end to end. Her `minideb` page and `selfie` correction are
  waiting on her desk: ask her to propose them.
- **Shipping and the surface.** `onionsoup_ship` restarts the services in the owner's `deploy` section with a health
  check. The surface's opencode loads the plugin, so plugin changes need `onionsoup-surface` restarted too; listing
  it in `deploy.services` makes ship do it, at the cost of cutting off any reply in progress.
- **snosi builds run only in CI.** mkosi needs root, so Murbella verifies with snosi's static checks and relies on
  GitHub Actions for builds (CI failures wake her). Local builds would need a privileged build VM on minideb,
  requested from Miles Teg like the smoke-test instances.
- **Autonomous runs cannot use owner MCP tools.** Declared `mcp:` servers are available in chats only; duties and
  hires in the sandbox do not get them (the NAS owner's snapshot and updates use host code instead).
- **No budgets.** Per-owner cost caps and wake-rate limits are designed but not enforced, and cost is only tracked
  for providers that report it (Copilot); ChatGPT OAuth reports $0.

- **Initiative chains stall on the person's merge.** An assignment completes only when its PR merges, so each step
  waits wherever a PR waits to be merged (the initiative view says so), unless the report holds a `merge` grant for
  its repository.
- **No initiatives between peers.** Only a manager plans across owners, through its direct reports; peers still
  delegate one request at a time, and the receiver may decline.
- **Waking a manager needs the surface running.** Manager notices are posted by the plugin in the surface's
  opencode; with the surface down they stay queued. If the initiative's chat was deleted, the notice stays pending:
  there is no fallback to the manager's latest chat yet. Tool lists are built when the plugin starts, so a
  `reportsTo` change shows new tools only after a surface restart (engine checks apply at once).
- **Owner sessions need the surface running.** The plugin opens the sessions that plan delegated work and carry out
  approved plans, so a plan approved from the inbox or the CLI waits for a running surface before any work starts.
- **Plans approved before plan worktrees still share the desk.** A plan item already `working` when plan worktrees
  shipped has no `planWorktree`; it proposes from the desk as before, so two such plans in one repository still
  bundle each other's changes. The person untangles them (cancel one, or move its changes by hand); new plans each
  get their own worktree.
- **A finished plan's work session drops out of the lists.** opencode lists sessions by the directory they were
  made in. Once a merged or cancelled plan's worktree is removed, the ledger points its session at the desk (so
  notices still arrive), but the owner's chat list and the item page no longer list it; the item page still links it.

## Surfaces

- **The Desk polls** every 20 seconds and has no push. It cannot open itself, and a job cited in chat cannot link
  to its page.
- **Personas are thin in the UI:** the surface shows a name and an icon. No portraits.
- **Plugin changes need the surface restarted** (its opencode loads the plugin), and the daemon needs a restart for
  engine changes.

## Runtime

- **Friction triage and issue gate are not implemented.** Owners can capture bounded, deduplicated friction reports
  in the surface, with one durable pending wake intent for each new signature. No daemon worker consumes these
  intents yet; workaround delivery must pin the saved origin, and publishing a draft GitHub issue must have its own
  person approval gate. A missing failure event stays explicit and makes deduplication provisional. The opencode
  plugin exposes a message ID but no invocation ID; identical submissions in one assistant message can share an
  idempotency key. An interrupted pre-write submission blocks other reports of its signature until that submission
  retries; there is no operator recovery control yet. Existing journal failures between append and acknowledgement
   can replay a short entry on retry.
  The friction index bounds record reads on routine surface polls, but old records, wake intents and submission
  markers have no retention or pruning policy. A missing or corrupt index needs explicit repair rather than
  silently discarding reports.

- **Legacy desk PRs remain untracked.** PRs recorded only as `desk-change-opened` journal entries before
  ledger-backed desk publication are not backfilled. They need manual GitHub maintenance; newly proposed
  desk changes have ledger records, maintenance and originating-chat notices.

- **Sandbox: provider credentials are still readable.** Masking the host opencode config/state closed the plugin
  path (`~/.config/opencode`), but `~/.local/share/opencode/auth.json` stays writable in every sandbox because
  hires must keep authenticating; a credential proxy that hides the real tokens from the sandboxed process is the
  next step.
- **Sandbox: no network isolation.** After the credential proxy, outbound network access from a sandboxed process
  is still unrestricted; an allowlist or a proxy is the follow-up.
- **App updates cannot roll back:** truenas-mcp exposes no rollback, so a failed update is raised for the person.
- **Held app updates are only re-read on a new version** or after 7 days; a person cannot say "this app's
  changelog lives in its commit log" except through the owner's notebook.
- **Charters are drafts written by Claude** for Bellonda, Miles Teg, Moneo and Leto. The person should rewrite
  them; they steer everything the owners do.
- **Duties have no event triggers** yet (`on:` is declared but unused); everything is scheduled or chat-driven.
- **Calendar briefings use an external timer.** The [systemd briefing runner](extending.md#calendar-briefings)
  delivers to an existing owner chat and records completion, but there is no built-in calendar scheduler,
  OpenChamber task import, or scheduling UI. Retiring OpenChamber stops its scheduled tasks even if their stored
  configuration still says enabled. Briefing failures are visible in systemd and run records, not the inbox.
- **Hires can loop until their time limit.** The hires that remain (desk reviews, CI triage, conflict decisions and
  resolutions) can degenerate (hundreds of trivial commands such as `echo`), and nothing notices before the time limit
  ends the hire. A progress watchdog (stop a hire whose recent tool calls change nothing) or a retry with the other
  model family would save the wait. Work with no chat or session of its own is journaled but has no chat to be told
  in.

## Workarounds to revisit

- **opencode webfetch permissions reject omitted defaults (seen in 1.18.32).** Its permission metadata includes
  an undefined `timeout` when the model omits it, so JSON encoding rejects both the event and permission list.
  The plugin's `tool.execute.before` hook materializes the upstream defaults (markdown, 30 seconds) in the
  original arguments. Explicit arguments and permission rules stay intact. Remove this workaround once
  a webfetch with no timeout or format produces a readable pending permission on a newer opencode.
  Existing requests already stuck in memory need the chat stopped and retried after the surface reloads
  the fixed plugin; changing the hook cannot repair an already-created permission.

- **opencode cannot return structured-output sessions (seen in 1.18.32).** Once a prompt carries a `json_schema`
  format, listing that session's messages over HTTP fails with `BadRequest: Expected OutputFormatJsonSchema`.
  Every hire asks for structured output, so two things work around it:
  - `packages/owners/src/opencode.ts` prompts hires synchronously and takes the deliverable from the prompt's own
    reply instead of reading the session back.
  - `packages/surface/src/hire-store.ts` reads hire sessions for the work item activity rail straight from
    opencode's SQLite store (read-only), which ties the surface to opencode's internal tables.

  To check a new opencode: run any hire, then `GET /session/<id>/message` on the server that ran it (or, in the
  surface, point the item-messages route back at `state.opencode.messages`). If it answers, drop both workarounds:
  prompt hires asynchronously and read sessions through the API.
- **An opencode server does not see sessions other servers create.** It lists a folder's sessions from what it has
  loaded, and hires are created by the daemon's own servers, so the surface's opencode never listed a hire that
  started after the surface did. The activity rail finds an item's hire sessions by title in opencode's store
  (`readSessionsTitled` in `packages/surface/src/hire-store.ts`) instead.
