# Gaps

What onionsoup cannot do yet, most important first. Owners (Leto in particular) should shrink this list.

## Owners and their authority

- **History preserves identity, not an independent transcript backup.** Archived owner conversations remain
  discoverable after plan cleanup; transcripts still depend on OpenCode's store. Unobserved children and deleted
  transcripts cannot be reconstructed. New chat uses a fresh workspace but does not automatically carry selected
  historical context. Existing explicit ledger references are readable without a bulk backfill.

- **Attention assignment is repository-only.** Seen remains inert; explicit assignment creates one gated request
  without resolving the attention entry. Assignment generations, reassignment and a blocked-routing recovery UI
  remain follow-ups. Existing acknowledged notes are never automatically interpreted as assignments.

- **Uncertain revision delivery requires inspection.** New inbox/manager plan revisions have durable delivery
  intent and stable receipt reconciliation; an uncertain send is not automatically retried. There is no delivery
  repair/resend UI yet. Pre-send prerequisite blockers resume when the prerequisites return; uncertain sends do not. In-flight model submissions cannot be recalled, and old work notices retain their existing
  delivery mechanism. Revision is distinct from cancellation, not a new goal-management layer.

- **Cross-owner progress is recorded state, not omniscience.** Request participants and the receiving owner's
  direct manager can read linked progress without relaying it through the person. Origin-pinned updates are
  informational and do not wake a model. Missing origins stay pull-only; there is no historical backfill.
  Request-scoped host proposal attempts expose bounded test/review evidence, with stale and superseded labels.
  External/manual work has no such evidence until a supported host proposal or reconciliation runs; between-tick transitions can be missed.
  Status does not independently check live services or prove deployment.

- **Direct-request plan review needs a reachable origin chat.** A requester who is the receiving owner's manager
  can review under its existing applicable `approve-plans` grant. A separate durable continuation wakes that
  requester; informational notices remain inert. Missing origin/persona/session blocks delivery and leaves the human
  inbox available. Pre-send prerequisites retry; an uncertain attempted send is reconciled by its receipt and never
  blindly repeated. Scope matching is an explicit reviewer assessment, not a host inference from prose. Unresolved
  scope stays at the human gate. Peer reviewers and blanket coordinator authority remain unsupported.

- **Actionable consultations currently cover repository changes only.** Explicit `onionsoup_ask` follow-up routes one
  proposal to existing gated work. Missing live evidence, wiki edits and household operations still need their
  existing tools. New explicit handoff intents recover through the daemon without replaying old notices. Blocked routing
  after three transient attempts (or one invalid-scope attempt) requires diagnosis; there is no cross-message semantic deduplication yet.

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
- **Operator writes and checks require exact approved scope.** Durable jobs support read-only investigations and
  named-file edits/creation in clean Git worktrees, with separate human decisions for exact paths/check commands and
  the completed diff. Checks support `node --test` with literal test paths and `go test` / `go vet` with local package paths.
  Go requires a host-selected toolchain and self-contained module; no CGO, host caches or dependency downloads.
  Package installs, package scripts and other toolchains remain unsupported. Each Go check deliberately snapshots
  its runtime again; copy-on-write is used when available, but unsupported filesystems incur a bounded full copy. They do not run arbitrary shell commands, delete paths, commit or push. Whole-workspace conflicts
  are refused; accepted edits remain uncommitted. Combined previews verify disjoint accepted edits from one repository/base with already approved checks; applying, committing and publishing that preview remain separate user-directed work. Prepared combined checks with unknown termination are retained and never replayed; this slice has no recovery for that uncertainty. An uncertain prepared mutation keeps its reservation and has no
  replay or recovery path in this slice, including failures after intent is recorded but before the writer starts.
  Zero-mutation write children can use explicit human recovery only after verified absent or idle owned runtime
  state. An offline runtime cannot establish that proof, even for a never-launched child with a session ID.
  Read-only children retain their existing bounded observation and human abandonment path. Unknown parent wakes
  are not replayed. The fixed file writer and approved check runner are sandboxed; the parent operator remains trusted
  and unsandboxed. The first scope click remains required; only exact retries of the approved job reuse approval.
  Removing that click needs a structured-intake authority decision, not natural-language interpretation or a blanket grant.
  The surface supplies the fixed writer's trusted Node runtime. Externally launched OpenCode must receive that
  host runtime explicitly or scoped writes fail closed.
- **Plan approvals in chat do not survive a restart.** A plan approval pending in a chat is lost if the surface restarts (the
  permission prompt lives in its opencode); the item stays `awaiting-plan-approval` and the owner resubmits it with
  `item`.
- **Desk changes need a first real run.** `onionsoup_propose_changes` (verify → cross-family review → commit →
  push → PR → merge under a `merge` grant → publish if the owner is a site source) is built, but it has not yet run
  end to end. (The wiki no longer goes through it: its keeper writes pages directly, see the next item.)
- **The wiki is read-only in the browser.** The wiki route is `/wiki/` on the existing `127.0.0.1:4747`
  surface, with no second listener. A legacy `listen` configuration is ignored for rollback compatibility.
  There is no editing in the browser, and only the
  keeper writes. A move does not rewrite links to the moved page (its backlinks list them). A `wiki_push_conflict` needs someone to rebase the
  clone by hand. Corrections reach the keeper as `onionsoup_ask` exchange notices, which she sees only when the
  person next chats with her.
- **Shipping and the surface.** `onionsoup_ship` restarts the services in the owner's `deploy` section with a health
  check. The surface's opencode loads the plugin, so plugin changes need `onionsoup-surface` restarted too; listing
  it in `deploy.services` makes ship do it, at the cost of cutting off any reply in progress.
- **Guarded release remains best effort for chats and plugin identity.** The worker drains
  admitted leases, checks known owner/operator/plan directories, scans `/proc` for another
  opencode and requires a quiet interval plus a last check. An unknown directory or a process
  appearing between scans can still be missed. It verifies both services, reported surface
  build and its recorded opencode child's authenticated health, but the public `/api/state`
  cannot attest the responding build or loaded plugin. The person accepted this risk for
  [guarded deployment](deployment.md); a global status protocol and plugin attestation remain
  follow-ups. `Type=simple` does not itself signal readiness.
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
- **A finished plan's work session drops out of the lists a day after it goes quiet.** opencode lists sessions by
  the directory they were made in, and the surface lists an owner's desk and the plan worktrees that still exist.
  A finished plan's worktree is removed once its session has been idle for
  `PLAN_WORKTREE_LIMITS.idleBeforeRemovalHours` (24); after that the owner's chat list no longer shows the session
  (the item still records it, in its old directory), and a prompt sent to it fails because the directory is gone.
- **Only the surface's opencode removes finished plans' worktrees.** The cleanup pass needs the session's activity,
  so it runs in the plugin; while the surface is down, finished plans keep their worktrees.

## Surfaces

- **The Desk polls** every 20 seconds and has no push. It cannot open itself, and a job cited in chat cannot link
  to its page.
- **Personas are thin in the UI:** the surface shows a name and an icon. No portraits.
- **Plugin changes need the surface restarted** (its opencode loads the plugin), and the daemon needs a restart for
  engine changes.

## Runtime

- **Friction issue publication and verified closure remain manual.** Owners can capture bounded, deduplicated friction reports
  in the surface, with one durable pending wake intent for each new signature. An opt-in daemon worker investigates new reports into durable sidecars (see the design page); automatic proposal
  promotion (explicit human promotion is supported), uncertain-session reconciliation and approved legacy backfill are not implemented.
  Source freshness compares only with the local checkout (never fetched), and revalidation is manual
  (`owners friction-revalidate`). A person can explicitly retry one `failed` claim once per reference commit
  with `owners friction-revalidation-retry`; uncertain attempts still require inspection and cannot be replayed.
  The recent-100 discovery window can miss older eligible reports after a burst; explicit ID investigation is available.
  A blocked investigation needs operator review; there is no reset/retry control. Workaround delivery must pin the saved origin, and publishing a draft GitHub issue must have its own
  person approval gate. A missing failure event stays explicit and makes deduplication provisional. The opencode
  plugin exposes a message ID but no invocation ID; identical submissions in one assistant message can share an
  idempotency key. An interrupted pre-write submission blocks other reports of its signature until that submission
  retries; there is no operator recovery control yet. Existing journal failures between append and acknowledgement
   can replay a short entry on retry.
  The friction index bounds record reads on routine surface polls, but old records, wake intents and submission
  markers have no retention or pruning policy. A missing or corrupt index needs explicit repair rather than
  silently discarding reports.

- **Legacy desk PRs remain untracked.** PRs recorded only as `desk-change-opened` journal entries before
  ledger-backed desk publication are not backfilled. They need manual GitHub maintenance; approved request
  items with their clean source worktree can now be explicitly reconciled using `owners reconcile-pr` after
  fresh verification and review, or factually linked with `owners observe-merged-pr` without accepting
  completion or clearing outstanding review findings. Later merged fixes can satisfy the original goal through
  explicit `owners prepare-request-closure` and `owners accept-request` commands, with fresh verification,
  independent review and a separate human acceptance receipt. This narrow flow has no browser acceptance
  button, bulk backfill or general live-outcome attestation. Newly proposed
  desk changes have ledger records, maintenance and originating-chat notices.

- **Sandbox: provider credentials are still readable.** Masking the host opencode config/state closed the plugin
  path (`~/.config/opencode`), but `~/.local/share/opencode/auth.json` stays writable in every sandbox because
  hires must keep authenticating; a credential proxy that hides the real tokens from the sandboxed process is the
  next step.
- **Declared provider keys reach the sandbox's environment.** A `providers.yaml` API key is written into each
  hire's `OPENCODE_CONFIG_CONTENT`, so anything the hire runs can read it, like `auth.json`; the credential proxy
  would cover these keys too. The surface opencode also holds them in its config, which its API can return.
- **Provider health is reactive.** A provider is marked failing only when a hire or chat on it fails, and cleared
  only when a call to it succeeds: nothing probes providers, so a key that expires overnight shows at the next use,
  and a failing provider nobody uses stays failing until the next call. Copilot's token refresh is opencode's; a
  refresh that fails shows here as that provider's authentication failure.
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

- Desk reviewers receive tree-bound host check metadata and original task criteria. Explicit repository-request closure can now accept a reviewed integrated result after historical merges and follow-up fixes. A general evidence-unavailable workflow and live-environment evidence adapters remain future work; command success alone is not deployment or goal completion.

- **Persona-free owners have observation chat only.** They can inspect recorded state and consult other owners,
  but cannot execute domain changes or reminders. Migrating the legacy persona requirement in `canChange` to an
  explicit capability would require a separate compatibility/authority decision; adding chat does not perform it.

Typed attention reconciliation currently covers host-verified plan-worktree cleanup only. Legacy free-text notices and other condition producers require explicit identities and positive clear evidence; they are not inferred closed or migrated automatically.
