# Owners

Living document: how onionsoup works today. Gaps are in [gaps.md](../gaps.md); how to create your own owners
and tools is in [extending.md](../extending.md).

## Overview

Onionsoup runs **owners**: persistent agents that each own one domain, such as a repository, a set of
virtualization hosts, a NAS or a wiki. An owner has a name and personality, a charter written by its person,
a notebook it curates, and authority bound in configuration. It watches its domain, answers questions about
it, and runs its own work: it plans with the person in chat following **skills** (a process adapted from
obra/superpowers), and carries out an approved plan in its own session. It may implement and review tasks
locally or delegate bounded work to its configured implementer/reviewer subagents when useful.
Per-task dispatch is optional; the one final required independent-family publication review is not.

The runtime, not the prompt, enforces how work happens: plans wait for a person's approval, and what an owner
proposes is verified by host code in a sandbox, reviewed by a different model family, and only then committed,
pushed and opened as a PR. Anything that creates, deletes or destroys waits for a person unless the person
granted standing approval in configuration.

Repository documents read as the project's record: decisions, rationale and consequences. Owner prompts and the
implementer subagent keep conversational process history in PR descriptions, commit messages and notebooks; the
required review checks for narration about who asked or which owners were consulted. Repository-specific
templates, conventions and review guidance take precedence over this general writing guidance.

```
          events · schedules · deterministic checks · a person in chat
                                   │
                                   ▼
   ┌────────────────── owner (always on) ────────────────────┐
   │ persona · charter · notebook · authority · duties · desk │◄── ask / request ──► other owners
   └──────┬───────────────────────────────────────────────────┘
          │ skills: brainstorm · write the plan · onionsoup_submit_plan
          ▼
     gate: the person approves the plan (in chat, the inbox, or a manager under a grant)
          │
          ▼
     work session: local implementation/review, with optional bounded delegation
          │ onionsoup_propose_changes
          ▼
     host code: verify in the sandbox → required review (another family) → commit · push · PR
          │
          ▼
     gates: merge · create/delete · destructive actions (or a standing grant)
```

The person talks to owners in the **surface** (`packages/surface`) or the opencode TUI. Each owner is an opencode
agent whose chats run in its desk (or evidence folder). The surface is organized around owners: a rail of owners
with what waits and what runs (a three-dot pulse for running work; the owner's icon amber while a chat prompt or
question waits on the person, else accent while any of its sessions (desk, plan worktrees, subagents) is busy in
opencode or a runner holds one of its items, read with the inbox and refreshed on opencode's session and permission
events; items a runner holds, such as a `maintain-prs` rebase whose hires run on sandboxed servers, are listed under
the owner and link to their item page), one inbox of every gate and chat permission with the decision in place, and per owner
its chats (drawn like OpenChamber's, whose styles it borrows under MIT), work, activity and notebook. The Friction
rail lists bounded incident reports and links them to their first reporting chat. It is a small
Node server that starts its own opencode (which loads the plugin from the person's real, host config — see the
threat model below), imports the engine directly, relays opencode's events to the browser, and keeps the
person's settings (owner order, per-chat auto-accept); the opencode password never reaches the browser. Inbox questions use the same form as chat: answers are collected
in question order, support multiple selections and permitted custom responses, and submit together. A work item's
page shows its plan (markdown), who approved it and a link to its work session; its activity rail lists the work
session and the subagent sessions it started (read from the surface's opencode) plus any hires, then the
publication stage, host verification and reviews, with each finding's issue and suggestion. Its decisions are
approve or send back a plan, retry, resume and cancel. On a phone (below Tailwind's `lg`, portrait and landscape)
the rail, an owner's desk and an item's activity become drawers opened from the page's top bar, so the chat keeps the
width; the app follows the visual viewport so the composer stays above the on-screen keyboard, pads for the notch
and home indicator (`viewport-fit=cover`), keeps fields at 16px so iOS does not zoom, and gives touch targets 44px.
OpenChamber and its Owner's Desk panel came first and were retired for it.

If a chat directory, permission list or question list cannot be read, the surface reports the affected
owner and operation while keeping other owners and engine gates available. A failed read never means there
are no pending approvals. A successful refresh clears the warning. If the entire snapshot fails, the
surface keeps its last snapshot and warns that displayed items may be stale.

## Engine and configuration

Onionsoup is the engine. A person's owners are configuration that lives outside the repository:

| What | Where | Default |
| --- | --- | --- |
| Engine: runtime, CLI, opencode plugin, Owner's Desk | this repository | |
| Your owners: declarations, charters, freelancer models, model families, model providers, the wiki | `ONIONSOUP_CONFIG` | `~/.config/onionsoup` |
| Runtime state: notebooks, ledger, requests, checkouts, desks, plan worktrees, evidence, tools, the wiki's clone | `ONIONSOUP_HOME` | `~/.local/share/onionsoup` |

`npm run owners -- init` creates a config directory from [`examples/starter`](../../examples/starter) as its
own Git repository. Declarations contain no machine paths: an owner's workspace defaults to
`<home>/checkouts/<id>` (repositories) or `<home>/evidence/<id>` (everything else).

## Concepts

### Owners

An owner is declared once (`owners/<id>.yaml`) and keeps one identity across sessions and model changes:

- **Persona**: a name, title, source and voice (these owners are named from *Dune*). Identity, never authority.
- **Charter** (`charters/<id>.md`): the person's statement of domain, goals and boundaries. It steers everything.
- **Domain**: `git-repository` (verified by declared commands), `repository-group` (several related repositories
  owned together; each work item, desk and PR names its repository and gets that repository's checkout, desk and
  verification), `incus` (observe; create/delete behind gates),
  `truenas` (through truenas-mcp, with hosted sites) or `github-org` (observed with gh). A repository owner may
  also hold an `incus` section, and a `deploy` section for where its code runs (the ship action).
- **Duties**: what it does on its own, on an elapsed interval (`every: 15m | 1d | 7d`), not at a local clock time.
  Calendar chat briefings can use the [external systemd runner](../extending.md#calendar-briefings).
  Kinds: `survey` (look, update the notebook, and record suggestions in owner backlog, never implicit human
  decisions or work items), `maintain-prs` (deterministic), `request-instance`, `app-updates`.
- **Conversation mode**: per-pattern `allow` / `ask` / `deny` rules for chats. Every chat gets a read-only floor
  (`READ_ONLY_COMMANDS` in `bash-rules.ts`: files, git history and `git fetch`, GitHub reads including `gh api`
  GETs; their write forms, such as `gh api -X PATCH`, ask). Repository-changing owners
  have local edit/development conveniences in their already-authorized workspace; explicit declared rules
  override both, including for delegated descendants, and a declared catch-all deny gets neither. Unlisted
  commands still ask. These conveniences are not shell containment: chat bash remains an acknowledged
  unsandboxed gap.
- **Tools**: onionsoup tools, plus any MCP servers declared in `mcp:` (visible to that owner alone, with
  per-tool rules). The NAS owner gets truenas-mcp this way.
- **Stewards**: an owner with `manages:` creates, changes and retires owners within its scope through a tool that
  validates the whole configuration, refuses authority fields, asks the person, and commits to the config repo.
  The daemon re-reads the configuration every tick, so new owners start without a restart.
- **Grants**: standing approvals the person gives in configuration (`publish-site`, `update-app`, `merge`, `ship`,
  `approve-plans`), journaled as "approved by standing grant" whenever they are used.
- **Reporting line**: `reportsTo` names an owner's manager. The roster every owner reads is drawn as that tree, and
  a manager fans work out to its reports and follows it (see [Org chart and managers](#org-chart-and-managers)).
- **Desk**: a worktree on a `desk/<id>` branch (or the evidence folder for non-repository owners) where chat
  work happens. Desk changes become a verified, reviewed PR through `onionsoup_propose_changes`; only blocker findings send them back. The review diffs the desk against where it meets its base branch (the merge base), so a desk that fell behind shows only its own change. `onionsoup_sync_desk` (with a plan's `item`, that plan's worktree) brings a desk up to date in host code: uncommitted work (intent-to-add entries included) is set aside under a unique stash, the desk moves to `origin/<base>`, and the work comes back; a conflict keeps the stash and names the files, and commits no remote holds are never moved (`desk_has_unpublished_commits`). A desk put on an open PR with `onionsoup_checkout_pr` is not synced (`desk_on_pull_request`): moving it would drop the PR's commits, and the PR's conflicts with its base are the `maintain-prs` rebase's to resolve, which the refusal names when one is open. Planning sessions start from a synced desk; an approved plan works in its own worktree, not the desk (see Execution sessions). Required desk reviews receive sanitized host command exit statuses tied to the exact source tree and observation time, plus the original approved task acceptance criteria. No configured commands is explicitly reported as no checks; sandbox evidence never implies live deployment. Source changes during verification or review invalidate that evidence before publication. Approved-plan publication retains its original goal instead of replacing it with the implementation summary. Review converges: each round with blockers is kept (`state/desk-reviews/`), and the next reviewer gets its findings and the diff since, checks those first, and blocks new points in already-reviewed text only for real errors. After `DESK_CHANGE_LIMITS.reviewRoundsBeforePerson` rounds (6) no reviewer is hired: the person reads the diff, and `owners desk-review-reset <owner> [repository] [--item <plan>]` starts afresh (a plan's worktree keeps its own rounds). An approval clears the history. Publication is a ledger workflow: commit, push, PR creation, merge and site follow-up have durable checkpoints. Retrying a clean desk continues its unfinished publication, and its PR participates in maintenance. An active publication reports its progress; permanent failures name the cancellation needed before a new proposal. Journal failures remain visible without changing a completed publication back to failed.

### Chat identity without a persona

Every declared owner has a chat identity. Existing persona names remain the opencode agent names, preserving
existing chats. An owner without a persona uses `onionsoup-owner-<owner-id>` and appears as **Observation-only chat**.
Configuration rejects collisions involving these new fallback agent names, including the operator and internal
reviewer/watcher names. Existing persona-name validation remains unchanged.

The fallback can read its existing workspace, notebook, recorded evidence and status, and ask another owner an
informational question. It has no shell, edits, subagent dispatch, configured MCP capabilities, scheduling, plan
submission, publication or deployment tools. Host handlers also refuse effect tools and `onionsoup_ask` follow-up
requests from this identity. Opening chat creates its workspace folder if missing, but does not clone, refresh or
create a desk. Normal conversation history, context and decision journaling still work; this is observation-only
with respect to domain effects, not a promise that chat creates no runtime records.

Reminder dispatch remains persona-gated, including
already pending reminders; this change never wakes them. `canChange` and plan execution retain their existing persona requirement. This is a
compatible chat-availability change, not an automatic migration to new repository-write authority. The operator
remains a separately configured identity. Registering the new agents requires the normal surface restart procedure;
changing or removing an existing persona is not a history migration.

### Owners run their work

An owner that owns repositories and has a persona changes them itself (`canChange` in `declarations.ts`); other
owners observe, raise what needs the person, and ask a repository owner for changes (`onionsoup_request_work`).
Small, clear changes are made on the desk in chat and proposed with `onionsoup_propose_changes`. Anything bigger is
brainstormed with the person, written as a plan, approved, and carried out in its own session.

**Skills.** The process lives in skills in `packages/owners/skills`, adapted from
[obra/superpowers](https://github.com/obra/superpowers) under MIT (see `packages/owners/skills/NOTICE`):
`brainstorming`, `writing-plans`, `subagent-driven-development` (with its implementer, task-reviewer and re-review
prompts), `executing-plans`, `requesting-code-review`, `receiving-code-review`, `systematic-debugging`,
`test-driven-development`, `verification-before-completion` and `using-onionsoup-skills`. Desks, onionsoup tools and
host gates replace the worktrees, commits and scripts of the originals. The plugin registers the directory with
opencode (`config.skills.paths`) and puts `using-onionsoup-skills` into the first message of an owner's top-level
sessions as a bootstrap; the owner loads the others with the skill tool. Subagents' child sessions (found through
their `parentID`) never get the bootstrap.

**Subagents.** The plugin's config hook defines them from configuration, beside the owner agents:

- `onionsoup-implementer`, shared by every owner: its model comes from the `implementation` freelancer; it edits
  and runs any command but committing, pushing, `gh` and `sudo` (`IMPLEMENTER_BASH`).
- `onionsoup-reviewer-<owner-id>`, one per owner: read-only, with the first `review` freelancer model outside the
  owner's family. It makes no edits, and its bash is `READ_ONLY_BASH`: the chats' read-only list (`cat`, `git
  rev-parse`, `gh pr checks`, `gh api` GETs…) with every write form denied, since nobody can answer an ask. Owner
  and reviewer hires use the same rules.

An owner may implement and review tasks itself; implementer and task-review dispatch are independently optional.
Missing task models do not block local work, but publication still requires its configured final independent-family
review. An owner's task permission lets it start only its own two subagents, and subagents are denied every `onionsoup_*`
tool: effects and records stay with the owner and host code. A subagent's edits, and commands outside the owner's
allowed rules, are journaled to the owner whose session started it (kind `subagent-action`). A subagent whose model
the configuration cannot supply is left out with `onionsoup_subagent_unavailable` in the log instead of breaking
chats. Freelancer declarations (`freelancers/*.yaml`) now only name models: `implementation` (the implementer
subagent, and conflict resolution hires in rebases) and `review` (each owner's reviewer subagent, the required host
review of desk changes, and the review of conflict resolutions). A `craft: planning` file, a `workflows/` directory
and `workflow:` lines on owners are left over from the retired freelancer pipeline and ignored.

Host hires that return a typed deliverable (reviews, owner answers and decisions, distill) and the decision watcher
ask for it in the reply text: the brief ends with the JSON Schema, and the reply's JSON is parsed and validated against
the same schema, with one resend if it does not match. opencode's structured output forces a tool call, which Copilot's
Claude models refuse (anomalyco/opencode#46735), so it is not used. Any model can serve as an owner, implementer or
reviewer.

**Plans and approval in chat.** `onionsoup_submit_plan { title, goal, plan, repository?, item? }` records the plan
as an `owner-change` work item: status `awaiting-plan-approval`, the plan's markdown and digest, and the chat as its
origin. The tool then asks the person in that chat through the permission prompt `onionsoup_plan_approval`. Every
persona asks for it, and the surface's per-chat auto-accept never answers it (nor `onionsoup_ship` or
`onionsoup_owner_change`), so a model cannot approve its own plan. A denial keeps the plan waiting with the person's
note as plan feedback; the owner revises it with them and submits again with `item`. An approval records who approved
and moves the item to `working`.

**Execution sessions.** An approved plan runs in a new owner session on the surface's opencode, titled
`Plan <id>: <title>`, where the person can watch and step in. The session runs in the plan's own git worktree, not
the owner's desk: host code makes it from the repository's checkout at the current `origin/<base>` (fetched first),
at `<home>/plans/<owner>/<item>` on branch `plan/<item>`, and records it on the item (`planWorktree`). Two plans in
one repository once shared a desk, so proposing either would have bundled the other's unreviewed changes and both
stopped; with a worktree each they proceed and propose independently, and the desk stays for chat and small direct
changes. A session reopened after a failed start reuses the worktree and syncs it. The session may edit its worktree
under the local-work conveniences unless configuration explicitly denies edits. No execution-session override
bypasses a declared deny. Its first message, marked as a runtime notice, is the approved plan with any conditions
of approval, and lets the owner use `executing-plans` locally or optional `subagent-driven-development`, to
make and record the rulings the plan leaves open, and to end with `onionsoup_propose_changes` for the item. The
reviewer subagent grades on the same scale as the required review (`REVIEW_SEVERITIES`), so blockers surface per task;
there is no whole-change review of the owner's own, since the required review at proposal is one and a send-back
commits nothing. After `DESK_CHANGE_LIMITS.reviewRoundsBeforePerson` send-backs, the person reads the diff. The item
reuses its unchanged approved goal, approval and applicable grants for replies, retries and maintenance;
changed scope and genuine world effects still use their original gates. There is no mandatory per-task
review/reset protocol for owners. The item
records the session (`session`). A plan approved in chat opens its session at once; one approved from the inbox, the
CLI (`owners approve`) or by a manager stays `working` without a session, and the plugin opens it on its next pass
(every `PLUGIN_LIMITS.noticeMs`). The plugin holds the opencode client, so sessions open only while the surface runs;
`openNeededSessions` in `owner-sessions.ts` retries a failed open on the next pass.

**The required review at the end.** `onionsoup_propose_changes` with an approved plan's item (status `working`)
carries that item through the same host path as any desk change: verification in the sandbox, then a required
review hired from the `review` freelancer outside the owner's family, then commit (on `owners/<item>`), push, PR,
merge under a `merge` grant, and a site publish follow-up when the owner is a site source. Only blocker findings send
the change back; the review brief defines the severities (blocker, major, minor, nit), and the PR body lists the last
round's findings for the person who merges, then folds in the approved plan. Without `item` a proposal opens its own
`desk-publication` item as before. With an item that has a plan worktree, that worktree is what is verified, reviewed
(against its merge base, with its own review rounds) and committed; the desk and other plans are untouched, and an
unfinished publication blocks only proposals from the same worktree. Plans approved before plan worktrees existed
still propose from the desk. The item moves through `landing` to `landed`; completion of delegated repository work means
its PR merged. The worktree outlives the merge: the plan's session often keeps working there after its PR merges
(a rollout run from the worktree), so neither the finish step, the publication refresh nor a cancellation removes it,
and the item's session keeps its real directory. A plan is finished once it is `landed` with its PR merged or closed,
or `cancelled`. The plugin's cleanup pass (`removeIdlePlanWorktrees` in `plan-worktrees.ts`, on the same
`PLUGIN_LIMITS.noticeMs` pass that opens sessions) looks only at finished items that still have a `planWorktree`,
asks opencode for the session's status and last update, and removes the worktree and its branch once the session is
not busy (or retrying) and has not changed for `PLAN_WORKTREE_LIMITS.idleBeforeRemovalHours` (24); an item without
a session, or whose session is gone, counts from the item's own last update. Busy children also retain the
workspace. Dirty/untracked or unreadable work stays with a concrete `planWorktreeKept` owner-maintenance reason (ignored
files such as caches or a local `.env` are removed with the worktree),
never an implicit human decision. Clean terminal work uses the same merge-tree/squash containment check as desk
sync against the configured base, not remote commit reachability or the item's "landed" label. Unique commits,
including a distinct plan-branch tip, get durable local `refs/onionsoup/archive/plans/...` refs and
`planWorktreeArchives` history before routine retirement; no intent is discarded. Archives are not automatically
pushed or pruned. Session metadata is retired only after successful cleanup; a retained workspace remains usable.
Each removal is journaled (`plan-worktree-removed`), and transcript identities remain history.

**Draft publication.** `onionsoup_propose_changes` accepts `draft: true`
(`owners propose <owner> --draft --item <item> --note <title>` in the CLI). The saved publication
mode survives retries; a conflicting retry is refused. Draft mode creates a draft PR, checks that
GitHub still reports draft with auto-merge disabled, and suppresses grant-based merge and site
follow-up, including resumed checkpoints. It does not grant merge authority or make a PR ready.

**Repairs on the desk.** The `maintain-prs` duty keeps published PRs mergeable and green. Failing CI on a new head
commit hires the owner once for that commit to decide fix, flaky or person; no work item is opened. Its brief holds
the failed steps' logs, read with `gh run view --repo` for the repository each check link names (the daemon runs
outside any checkout), or `logs_unavailable` with gh's reason. `fix` wakes the
owner with a notice in the session or chat the PR came from. `onionsoup_checkout_pr { item }` puts a clean desk on
the PR's head, and `onionsoup_propose_changes` with that item reviews the fix against the PR head and pushes it with
`--force-with-lease` onto the same PR, refusing if the head moved; no new PR is opened.

**PR update maintenance.** The actual `maintain-prs` selector reads both GitHub mergeability and
`mergeStateStatus`: `BEHIND` is stale, not merely "mergeable". A behind PR gets a `rebase` work item in
`update-base` mode. Host code merges the existing published head with the current configured base, runs
configured verification, and binds the resulting tree. Before publication it rechecks the tree, clean source,
published-head ancestry and exact remote-head lease. This preserves the published commits and original goal;
it needs no model hire or new destructive-action approval. A changed head or source refuses publication, and
a real merge conflict falls back to the existing owner conflict-resolution path.
An owner can invoke `onionsoup_update_prs` to run its declared `maintain-prs` duty and advance the resulting
updates now. The tool selects no arbitrary repository or head and grants no new maintenance authority.
GitHub reports `BEHIND` only when branch protection requires up-to-date branches, so the duty leaves a stale but
mergeable PR alone. `onionsoup_update_prs { refresh: true }` also treats a mergeable PR whose head lacks the base
tip (read from the owner's fetched checkout) as behind, and takes the same `update-base` path; the periodic duty
never refreshes.

A conflicting PR gets a `rebase` work item. A clean replay that passes verification needs no
model. A conflict hires the owner (sandboxed, with its notebook) to decide whether and how it is resolved; it
briefs the implementer hired next (the `implementation` freelancer), a reviewer from another family checks the
resolution, and the force-push waits for the person (`approve-push`). Rebase maintenance preserves the whole PR, including earlier repairs, and skips
patch-equivalent commits already integrated on the base by a squash merge. Desk publications use the same
maintenance records. The chat that proposed a desk change is saved before publication starts, so a later close
notice returns to that chat; a merge, including one under a grant between daemon ticks, is journaled only. Open PRs
stay in the owner's Work list and status text even when newer completed work fills its recent history.

Migration policy: desk PRs created before ledger-backed publication remain untracked. Their legacy
`desk-change-opened` journal entries are retained as history, but are not automatically imported: they do not
reliably record the repository, reviewed head, or originating chat needed for safe maintenance. Existing
ledger-backed desk publications remain tracked; missing origins are not guessed from unrelated chats. Open work of
the retired `change` workflow fails once at daemon start with `pipeline_removed` (`retirePipelineItems`); its record
stays, and the owner can plan it again.

**Notices.** Owners hear how their work went: each daemon tick compares work items with what it last saw and
journals each change (landed, failed, rejected, PR merged or closed). Changes the owner must act on (all but a
merge, which the person did) also queue a notice that the plugin posts, marked as coming from the runtime, into
the item's work session first, else the chat the work came from. CI fix requests and send-backs of plans reach
the owner the same way. The owner decides the next step in front of the person.

**Shipping.** An owner with a `deploy` section and a `ship` grant ships its repository where it runs. Before touching
the deploy checkout, ship checks the full ledger and refuses with the IDs, titles and statuses of any items with
active runners, including other owners' work. Once clear, it fast-forwards, verifies in the sandbox, and restarts
only the owner's configured deploy services through a delayed systemd unit that health-checks and rolls back. This
up-front check does not prevent new work from starting during verification.
This is the legacy generic checkout ship path, not the onionsoup production release procedure.
Onionsoup itself uses the [guarded immutable deployment worker](../deployment.md): verified release
and manifest, admission drain, atomic pointer switch, **both** owners and surface restarts, authenticated
OpenCode/surface/build checks and verified rollback. Never edit or fast-forward the live main checkout or
clear locks to bypass drain. A release rollback does not roll back configuration or state.

### Notebooks and memory

Each owner has a notebook in a Git repository: `CHARTER`, `MAP`, `WISDOM`, `FAILURES`, `decisions`,
`open-questions`, and a journal. Everything the owner does is journaled; `distill` folds the journal into the
registers, and the owner is the curator. A notebook is knowledge, never authority.

Memory maintenance is automatic: the daemon checks for unread journal entries and runs bounded distillation
batches beside its tick, at most one owner at a time and after that owner's work and duties finish. Owner
`memory` configuration controls the interval, retry delay and batch limits. Empty journals never hire a model.
The notebook's **Update notebook** button and `owners distill <owner>` queue a manual pass without stopping the
daemon; the surface shows queued/running state and failures. A file-and-line cursor advances only through the
consumed snapshot, so decisions recorded during a hire remain for the next pass. Failed hires retain the cursor
and request for retry. Old timestamp markers are read on migration.

Chat memory is deliberate. Tool calls that were not auto-allowed are journaled deterministically. After each
exchange a watcher from another model family extracts only the person's decisions, kept only if the quote is
verbatim; they land in the journal as candidates, and distill decides what enters the notebook. The person can
retract a note from the Desk or in chat. Every owner sees a generated roster of the other owners. Its charter, the
roster and its reporting lines are read from the configuration each turn, so edits reach live chats without a restart.

An owner records facts it observes, and rulings it makes while working, with `onionsoup_record_fact { fact,
source, observedAt? }`. They come back to it word for word in every turn (`<recorded-facts>`, newest first, within
`NOTEBOOK_LIMITS.factChars`), so it can pass the ones a subagent needs into that subagent's task, and distill keeps
each one word for word in `MAP` (what exists) or `WISDOM`.

Each chat turn also reads a bounded recent journal tail: questions and answers, work outcomes, CI triage,
attention, owner changes and person decisions. This supplies activity performed outside the conversation before
it reaches the notebook. Retractions in that window suppress earlier matching decision candidates; a later decision can reaffirm them. The owner's
`chatContext` policy bounds age, entries, characters and bytes read; malformed or incomplete lines are skipped.
Recent raw decisions supplement answering briefs even before distillation, and can overlap distilled memory so
concurrent decisions are not lost to a timestamp cutoff. They are context, never authority.

An owner can use `onionsoup_friction` to capture unexpected engine behavior. The plugin attaches the chat origin,
running checkout commit (marked dirty when the checkout has tracked changes) and observed model (or explicitly
records them as unavailable), and only observed failed tool events, never raw arguments. Host code keeps one
bounded report per versioned owner/tool/error-class signature under `state/friction/records` and counts repeats;
when no failure event was observed, prose-based matches are marked provisional. Each submission journals a short
`friction` activity entry. The surface's Friction rail lists the reports with their counts and links each to its
first reporting chat; a person reads them and decides what to change. Capture never wakes an owner, dispatches
work or opens a request.

The deterministic PR maintainer now honors a recorded `owner_abandoned` rejection for the exact original
item/previous head, like an existing cancelled rebase. It does not repeatedly create the same unwanted update,
close the remote PR, blacklist ordinary errors or suppress maintenance when the remote head changes.

### Requests between owners

Owners ask each other questions (`onionsoup_ask`: answered from the other owner's notebook and fresh evidence,
split into observed, inferred and unknown). Both owners journal the exchange (`asked`, `answered`) and see it in
their recent activity; no chat is posted a copy. Exchange notices left in `notices/exchanges` by older builds
are inert: nothing delivers them. Owners also open requests to each other.

**Addressed conversation is not consultation.** `onionsoup_send { to, text, item?, session? }` queues actionable
conversation for a declared owner's actual context; `onionsoup_reply { message, text }` returns to the recorded
sender's exact session. The host binds the sender to tool context and proven session membership. Item addresses
prefer the item's execution session, then a proven recipient-owned planning origin; a requester-owned origin is
never assigned to the item owner. Without an address, host-observed owner session history selects the recipient's
most recently recorded general chat in its declared workspace, never an unrelated item's work session.
Without one it uses a fenced desk continuation. No consultation hire, work request, approval layer or effect grant is created.
Busy recipients wait in the existing work-notice queue.

Queue IDs are immutable, including delivered tombstones. Work-notice receipts retain the native message ID,
destination, agent and exact rendered body before transport. Returned SDK errors are failures; only an exact
transcript entry establishes acceptance. Restart reconciles an accepted-but-unacknowledged message without another
send. Unknown sends stay pending with an uncertain receipt and concrete reason, scoped to that message, never
fabricated as success or retried with a new ID. Positive pre-transport stopping proof permits the same ID to retry.

A removed or archived workspace remains history, not a usable address. Delivery preserves the old identity and
retained transcript, and opens/reuses one durable continuation in the recipient's current declared workspace
(or its still-existing approved worktree). It never recreates the deleted path. The continuation receives bounded
historical context and the original work/request identity; ordinary plan/effect gates remain unchanged. The
session-opening store reserves identity before creation; uncertain creation without a saved session cannot blindly
create again. Other messages and work continue. Transcripts still depend on OpenCode's retained store.

An explicit `onionsoup_ask` with `followUp: true` lets the read-only answer propose **one** change in the answering
owner's declared repository. Host code validates that owner can change that repository, then creates a regular
`work` request; receiver acceptance, plan approval, verification, review and publication gates remain unchanged.
Omitting `followUp` stays informational even if a model returns a proposal. This does not grant consultation write
tools, run NAS operations, or turn a wiki correction into a wiki write. Missing evidence remains in `unknown`.

The plugin supplies the originating session/message identity. That identity, caller, receiver and exact question
key an additive `state/handoffs/ask-<digest>.json` record. The first valid answer is persisted before opening
`r-handoff-<digest>` under a cross-process lock. Retrying the same tool input in the same originating message
reuses that answer and adopts the request's current state, including denial or completion. A crash between the
record and request is recovered by the admitted daemon tick or replaying that same ask. Only the new explicit
handoff store is scanned; old notices and attention are never replayed. Routing is bounded to 20 intents per tick
and three transient failed attempts per intent before `blocked`; invalid authority/repository proposals block on the
first attempt. Failures retain a reason code in the sidecar and the tool returns the paid answer with typed routing
status rather than losing it. Routing does not hire models. The request preserves the requester's origin.
Its routing marker is saved before journaling; separate journal markers retry request-opened entries without
blocking or changing the request. Journal failures log `handoff_journal_failed`; after three failures the reason
remains on the sidecar for diagnosis. A crash after an append but before its marker can duplicate a journal entry.
A process claim prevents concurrent consultation for the same origin. A live claimant yields
`handoff_consultation_in_progress`; a dead claimant can be replaced. There is no timer that steals a live claim:
a hung process must stop before retry, and PID reuse can conservatively delay recovery. No file lock spans inference. A new originating message is a new request, not semantic deduplication.
The asked/answered journal entries are best effort: a crash or write failure can omit them, and replay does not
recreate them. The full answer/origin stay in the handoff record; the daemon repairs the separately tracked
request-opened journal. The journals are informational, not the authoritative handoff state. Rollback leaves the
new sidecars unread by older binaries; regular requests retain their existing schema and execution semantics.

The requester now receives a current cross-owner progress summary in chat context and `onionsoup_status`.
Visibility includes request participants and the receiving owner's direct manager, matching report-work visibility;
it does not expose unrelated owners' work. Each row names the goal, accountable receiver, decision, linked work,
blocker, recorded PR evidence and next step. It gives the record-read time and last-change time, labels records
older than 24 hours as stale, and treats absent/mismatched linked work as unknown. Reading status does not probe
live services, and repository merge never claims deployment. Recently finished requests stay visible for seven days.
Injected cross-owner progress summaries (not all other chat-context sections) prioritize active requests and are bounded to 12 records and 12,000 characters. Omitted records
and abbreviated blocker details are explicitly labeled; `onionsoup_status offset=<next>` pages through them,
and `onionsoup_status request=<id>` reads details under the same visibility check.

Host proposal attempts and supported external-PR reconciliation for delegated work also write a request/item/owner-scoped view in
`state/request-work-evidence`: verification stage, exact source tree, host check exit codes, cross-family review
and blockers. Command arguments/output are excluded; review prose is redacted and bounded, prioritizing blocker
findings and labeling omissions. This is attempt evidence, not proof of current workspace state, deployment or goal
completion. Missing/unreadable evidence is unknown; old evidence is stale and a changed plan digest supersedes it.
Status shows new attempt evidence without model wakes; it does not import past reviewer/model claims. Evidence
writes are best-effort with metadata-only diagnostics and never change a proposal outcome. The next host attempt
replaces the view; existing review history remains with its original records. Historical external work stays unknown until its supported fresh reconciliation runs.
Consultation/status-only instructions apply to that interaction. A separately accepted work handoff follows its
own goal and existing plan/effect gates; it never inherits permission to bypass those gates.

New direct work requests and actionable asks retain the exact requester chat origin. The requester reads request
progress when it needs it (`onionsoup_status`, chat context); the runtime posts no progress notices into its chat.
Reads across request and ledger files are not transactional.

Request kinds:

| Request | From → to | After the receiving owner accepts |
| --- | --- | --- |
| `work` | any → repository owner with a persona | receiver accepts or declines (work from its manager is accepted automatically); accepted work becomes an `owner-change` item in `planning`, which the owner plans alone in a session the plugin opens (`Request <id>: <title>`); its plan waits in the person's inbox or for the manager's `approve-plans` grant, and the request tracks the linked work through merge or failure |
| `instance` | any → incus owner | person approves create (optionally the delete too), runtime creates, follow-up runs, delete; an image off the owner's `images` list or a name without its `namePrefix` is outside its grant but not refused: the inbox names each violation and the person's create approval covers that exact instance (remote permission and instance cap still apply), and onionsoup never deletes an unprefixed instance |
| `publish-site` | site source → NAS owner | grant or person, then build · stage · swap · restart app · verify byte for byte · roll back on failure |
| `update-app` | NAS owner → itself | grant or person, then upgrade the catalog or pull and redeploy images; follow the specific TrueNAS job to success |

App requests preserve image-update intent even when the catalog version is unchanged. Catalog upgrades use
truenas-mcp; image-only updates use the declared SSH connection to run `sudo -n midclt call app.pull_images`
with redeploy enabled (the SSH account needs permission for that command). Completion requires the tracked
job to succeed, the app to run at the target version, and image updates to clear. If a catalog upgrade leaves
image updates pending, a second tracked job pulls them; temporary polling failures retry within the deadline. Read-only recovery can confirm
a known successful job without starting another update. See the [TrueNAS API](https://api.truenas.com/v25.10/api_methods_app.pull_images.html).

People only record decisions (approve, revise-plan, resume, retry, cancel, approve-create, approve-push, …); the
runtime acts on them. A note given with resume or retry is kept on the item. Approving a plan is the person's
go-ahead for everything it describes, and its conditions of approval reach the work session with the plan.
Ledger updates use per-record kernel locks across daemon, CLI and surface processes.
Request decisions and runner cleanup update the latest
record under a cross-process lock. Each active request step records its operation identity and checkpoints before effects.
After a stopped runtime, recovery adopts an Incus instance only when its request tag matches, confirms deletion by absence,
checks a published site's saved index digest only after its restart and serving check were recorded, and checks an app's recorded job and final state. Uncertain outcomes remain
`interrupted` in the inbox: the person can check again, retry after inspection with a reason, or stop the request.
Instance retry first checks for an existing tagged instance; stopping a provisioned instance retains its delete gate.
A failed NAS job can be replaced on an explicit retry, while an active or successful recorded job remains attached.
Effect-free owner decisions and work-status checks retry with exponential backoff (three attempts by default), then
ask the person. Each tick detects dead request runners while preserving live CLI claims; read-only reconciliation
runs in the bounded request pool, so unavailable hosts cannot hold up the tick. Neither
recovery nor a follow-up silently replays an unknown effect.

`onionsoup_request_work` delegates to a declared repository owner that can change its repository (`canChange`).
Acceptance creates one durable linked work item, which the receiver plans alone and submits with
`onionsoup_submit_plan` and that item; it passes the normal plan approval, verification, review and publication gates. Both owners hear completion, and declined or failed work raises
owner follow-up for both. Attention discovery imports only the previous seven days on its first run (the cutoff is persisted; older journal
history remains intact). It then indexes appended bytes, caches unchanged files, and skips malformed records without
breaking the inbox. Attention items can be acknowledged, resolved with an outcome, or reopened through `onionsoup_attention`.
The human inbox includes only open human decisions; Seen removes a card from that queue and its owner's waiting
count without starting work or deleting history. Informational owner follow-up and all acknowledged/resolved entries
remain in the owner's backlog/history. Acknowledgment never makes an old condition newly urgent.

### Org chart and managers

The org chart is configuration: `reportsTo: <owner>` on a declaration. Loading refuses unknown managers
(`org_chart_unknown_manager`), self-reports (`org_chart_self`) and cycles (`org_chart_cycle`). A steward may put owners
in its scope under itself or take them back out, but never sets, changes or clears a line to anyone else. Each
owner's prompt says who its manager and direct reports are; `managerOf`, `directReports` and `isDirectReport` in
`declarations.ts` are the only readers of the field.

A manager is an owner with direct reports. For cross-repository change she fans the work out herself: one
`onionsoup_request_work` per report and repository, in whatever order the change needs. Work a manager requests from
a direct report is accepted automatically (no hire; only the report is reserved in the request pool) and still goes
through the report's ordinary plan approval, verification, review and publication gates. A peer's request is still
decided by the receiver. She follows each request with `onionsoup_status` (`request=<id>` for one request's progress)
and talks to a report in its actual work session with `onionsoup_send` / `onionsoup_reply`; a report that finds the
work wrong, unclear or blocked tells her the same way.

**Plan approval under grant.** A report may give its manager `approve-plans` (a grant on the report's declaration,
`to` its manager, target a repository or `*`; loading refuses one to anyone else with `grant_not_to_manager`). It
lets her review the plans of work she requested (direct-request review, below). Without the grant the plan waits for
the person as always. A person who sends a delegated plan back from the inbox moves it back to `planning` and wakes
the report where it planned.

**Direct-request review.** For a one-off work request, the requester may review its own direct report's plan under
the same configured `approve-plans` grant, using `onionsoup_review_request_plan`. `onionsoup_status request=<id>`
returns the original requested scope, submitted plan, exact request/item/digest and current review capability.
The digest binds both distinct goal texts, receiver, repository, plan and revision history; it does not assume
that a restated plan goal is identical to the request. Host code rereads configuration and validates the binding
inside the final request/item locks. A matched-scope approval records a durable review and grant use, then the
existing owner-session gate starts work. `revise` preserves the goal and uses durable plan-revision delivery;
`needs-human` records the precise unresolved scope question and leaves approval pending. It never approves extra
work merely because a model promised approval. Human inbox approval is unchanged.
The `SUPERVISION_LIMITS.revisionsPerItem` budget bounds automatic send-backs; after it is exhausted the
person decides the next plan.

The plugin's ordinary notice pass prepares a durable actionable continuation for each eligible direct-request
plan generation in the request's original chat. The wake uses a stable native message receipt, waits for an idle
origin and reconciles accepted delivery after restart.
Pre-send prerequisites retry; removed requester workspaces use the same owned continuation routing as addressed
messages. New wakes save their exact body and reconcile matching transcript receipts. An uncertain attempted send
without that receipt is blocked rather than blindly replayed; legacy ID-only evidence is not exact-body proof.
Changed plans invalidate prior bindings, and a recorded review suppresses repeat wakes.
Models execute outside record locks; a concurrent human decision wins the gate and stale model verdicts fail.
Scope matching is an explicit reviewer assessment with a note, not deterministic semantic analysis of prose.

**Steering.** A manager reads all her direct reports' work with `onionsoup_status`, whoever asked for it (her
requests, a peer's, their own work). `onionsoup_steer` (`org-work.ts`) acts only on a report's work item whose request
she sent: `cancel` cancels it (its request then fails, and only that request) and `note` leaves the report a note.
Every action takes a note and
is journaled (`steered`) to both; reading is oversight, steering is authority. A note is queued to the report's exact
owned work session rather than only journaled, and deduplicates by host originating session/message identity, so a
deliberate later repeat of the same words still reaches the report. The report continues the original request,
without cancellation, replacement, another approval layer or asking the person to carry the answer.

The surface shows the tree under **Org**.

Initiatives (a manager's multi-owner plan the person approved once, dispatched by the daemon) were removed in 2026-10:
cancelling one assignment failed the whole initiative, dispatched work could not be edited, and reports could not
push back on plain manager requests. Records under `state/initiatives/` are ignored. `assignment` on work requests and
items and the `escalation` attention provenance stay in their schemas only so old records parse; old escalation
cards resolve as `initiatives_removed`.

### Reminders

Some checks only make sense later: Miles Teg staged Coder with backups kept for 14 days, and whether retention works
can be confirmed only once 14 days of backups exist. Duties are recurring and declared in configuration, notices fire
only on events, and distill only reorganises the notebook, so an owner sets itself a one-off reminder with
`onionsoup_remind` (`set` with `after`, like a duty's `every`, or an ISO `at`; a prompt for its later self;
optionally a work item of its own or a direct report's). Host code keeps the time instead of a model reading a
heartbeat checklist on a schedule, and wakes the owner only when a reminder is due. Reminders live in
`state/reminders/<id>.json` (the record in `packages/owners/src/reminders.ts`; setting, cancelling and firing in
`reminder-work.ts`), and every set, firing and cancellation is journaled.

A reminder grants nothing: firing it gives the owner a prompt, and whatever it then does goes through the usual gates.
So owners set their own, within `REMINDER_LIMITS` (pending per owner, the shortest and longest delay, prompt length),
and each refusal names its code (`reminder_too_soon`, `reminder_item_not_yours`, ...). On its notice timer the
plugin opens each due reminder in a fresh owner session titled "Reminder: ...", in the owner's chat directory with its
desks synced, whose first message is a runtime notice with the prompt and the item's record. A claim under the
reminder's lock makes exactly one server open it, once; a reminder missed while the surface was down fires late. Pending reminders show in the owner's status and on its
page in the surface, where the person can cancel any of them. They are not in the inbox, since they wait on no one.

### Always on

The user-unit templates run from a manually prepared `release-root/current` symlink, with a
matching surface release manifest and a host opencode plugin URL through that pointer. The
[deployment guide](../deployment.md) describes bootstrap and rollback. The guarded release
worker discovers the surface's spawned, authenticated opencode endpoint through the shared
state directory. Its drain covers admitted work and known chat directories, not every
possible independent opencode session; its readiness checks do not attest the loaded plugin.
Each OpenCode plugin instance owns its maintenance timers. Its `dispose` hook stops the timers,
shares cancellation across maintenance reads, and returns after a bounded wait. Each pass holds an
admission lease until its SDK calls settle, then releases it, even when an invoked effect's outcome is
uncertain; a transport that ignores cancellation keeps the lease until its promise settles. Exact domain
receipts (work notice deliveries, session openings) prevent replaying an uncertain effect. A pass that
overruns its time budget is stopped and logged with its phase; nothing else is recorded.
Successful late effect receipts may be saved, but stopped passes cannot start another SDK effect or phase.
An already-started host placement or stash/restore transaction finishes under its held admission.

Owner and reminder session opening reserves its item/kind before creating a session. The durable
`state/session-openings/` record retains the token, phase history, exact origin and native message ID.
An ambiguous create or prompt keeps that reservation and never deletes or requeues the session.
Only an attempt proven stopped before create may reserve a new token. Work notices likewise retain their
claim and a `state/notices/delivery/` message receipt after an uncertain send. A notice proven not sent
may return to the pending queue, preserving its failed attempt receipt. These uncertain records
need diagnosis; there is no expiry, automatic replay or general recovery command. Existing specialist
operation tokens and wake receipts remain authoritative for their own reconciliation.

The host opencode plugin reconciles its own chat admission leases on a periodic pass
(`PLUGIN_LIMITS.noticeMs`). A missed idle event releases a top-level lease only after a
directory-scoped status omits the session (opencode lists busy/retry sessions) and the transcript ends in a completed, stopped assistant
message whose `parentID` is this lease's persisted user-message ID; if the marker is unavailable the lease
stays held. Children are enumerated in that directory and must likewise be absent or idle with final answers
(or have completed through their idle events). A child without a tracked user-message ID uses its latest transcript user;
one with no user cannot prove completion. Failed or malformed reads, pending child activity
and a memory nudge without its own completed answer keep the lease. During drain, only the plugin's pending
operator-memory nudge (matched to its generated message ID and exact text under the chat lock) continues on
the existing lease; unrelated messages still pass the drain admission gate. The final release rechecks status, transcript
and child evidence while serialized with chat completion and tool registration; normal
idle-event release still runs the decision watcher and operator memory handling.
Native tool errors may skip OpenCode's normal after-hook. Terminal-error events and the periodic
pass verify the exact registered session, call, tool and admitted user against the persisted
assistant tool part before removing its own and its ancestor's tool marker. Events alone are
not completion evidence; running tools, mismatched or unreadable history, and registration
races retain their markers. Removing a tool marker does not complete a turn or release a
later user's lease: the ordinary final-answer, child and idle checks still run.
These are accepted best-effort limits (see [gaps](../gaps.md)). Bootstrap is manual; arm
and enable the timer only after verifying both installed services and the plugin use the
release pointer.

`npm run owners -- daemon` (installed as `deploy/onionsoup-owners.service`) ticks every minute: it re-reads the
configuration, reads the state of every open PR (`refreshPublications`, so merges and closes are seen within a minute
and everything after reacts on the same tick), moves requests along, runs due duties,
advances runnable work items (publications of proposed changes and rebases; owners do the rest in their sessions),
and raises work notices. Requests, duties and work items run in the background beside the tick (one run per item,
one item per owner, within `DAEMON_LIMITS`; requests reserve both participating owners and serialize shared
resources), so a long hire never holds up a 15-minute check or a waiting request. Deterministic checks wake a model
only when one is needed, and that model is the owner. Work a stopped runtime was actually doing is marked
interrupted and never replayed; a person resumes it. At start, the daemon fails open work of the retired freelancer
pipeline once with `pipeline_removed`. Opening owner sessions and posting notices into chats is the plugin's job, so
it needs the surface running.
Shipping refuses while any item has an active runner, so a ship must be retried after the named work finishes
or is resolved. A manual daemon restart still interrupts active work.

Intentional pause, non-PR operational completion, attention assignment, request closure/acceptance and external PR
reconciliation were removed in 2026-10, unused. Stop work with cancel. The `pause` human-note kind, the `work-paused`
request status and `externalPrObservations` on work items stay in their schemas only so old records parse.

### Operator

Owners each hold one domain under gates. Some work belongs to no domain: operating onionsoup itself, reading across
every owner's records, a one-off job on the homelab. For that the person may declare an **operator** in
`operator.yaml` (`OperatorDeclaration` in `packages/owners/src/declarations.ts`; the agent in `operator.ts`): one
agent the person directs turn by turn in a chat of its own, like a coding agent in auto mode. It sits outside the owner
rules on purpose. It owns no domain, keeps no owner notebook, runs no duties, and is woken by the runtime only for the
memory nudge below; owners cannot
reach it (it is in no roster, and `onionsoup_ask`, `onionsoup_request_work` and friends resolve only owners). Its id
`operator` and its name are reserved: no owner may take either (`operator_reserved`).

Its permissions allow nearly everything: any bash, edits, the web, any directory, subagents and questions. Only
`OPERATOR_ASK_BASH` asks, plus the person's own `ask:` patterns: recursive deletes, force pushes, hard resets and
`git clean`, deleting incus instances, destroying ZFS datasets and pools, `mkfs`, `dd`, `kubectl delete`, and the
CLI's person gates (`owners ... approve*`, `owners ... ship*`), so it does not answer an owner's plan or ship for the
person unasked. It gets no `onionsoup_*` owner tools (they are denied, and refuse any agent that is not an owner)
except `onionsoup_wiki`, with which it only reads the [wiki](#wiki), so it cannot submit, approve or ship owner work
through them, and the plan-approval, ship and owner-change prompts of owners'
sessions are answered only in those sessions. It may load the person's operating skills in `.agents/skills`
(operate-onionsoup, ship-onionsoup, create-owner), which owners and their subagents are denied, and never gets the
owners' skills bootstrap.

The risk is plain: the operator is unsandboxed, runs as the person, and bash rules are a convenience, not a
boundary. Anything it reads (a web page, an issue, an owner's output) can try to steer it, and the prompt telling it
that such text is data, not instructions, is the only defence beyond the ask list. What it does is audited: every
command and edit it or its subagents run is journaled to `state/notebooks/operator/journal/` (a notebook without registers,
never distilled), so the person can see afterwards what it did. Every chat shell, the operator's and the owners',
gets the surface opencode's own server credentials blanked (the plugin's `shell.env` hook sets each of
`HOST_ONLY_VARIABLES` to empty), so no command can use them to answer another session's prompt through the API.

For parallel work it dispatches opencode's native `task` subagents, each with a concrete goal and directory, and
checks what they report before it tells the person something is done; their commands and edits are journaled with its
own. There is no operator job ledger, write gate or recovery protocol. A durable job system with scoped writes, host
checks and handoffs was tried and removed, after a one-file change took 95 minutes and three approval gates.

#### Operator memory

Each operator chat would otherwise start cold, so the operator keeps a memory of its own
(`packages/owners/src/operator-memory.ts`): plain files in `state/notebooks/operator/memory/`, an `INDEX.md` with one
line per topic (`- [Title](file.md) — one-line hook`) and one topic file per subject. The plugin seeds the index when
it starts, and puts it into every turn of a top-level operator chat as `<your-memory-index>`, clipped at
`OPERATOR_MEMORY_LIMITS.indexChars` with a request to consolidate. The operator reads the topics a task needs and
writes them itself; its prompt says what belongs there (how things are set up, fixes that worked, the person's stated
preferences, where things live) and what never does (what the repository, config or journal already records, and
secrets).

When a top-level operator chat goes idle, host code commits changed memory files to the notebooks repository
(`operator: memory: <files>`; the operator's journal commits take only `journal/`), then decides with
`decideMemoryNudge` whether to post one runtime notice asking whether anything is worth remembering. It nudges when,
since memory last changed, the chat and its subagents made `OPERATOR_MEMORY_LIMITS.nudgeAfterToolCalls` journaled
tool calls or edited a file under the person's configuration or the engine repository. A nudge resets the count and
marks the chat as answering it until the person's next message, so the answer is never nudged again; a change to
memory also resets the count. The counts live in the plugin's memory and a restart starts them over.

### Model providers

Models come from opencode's providers. A person adds OpenAI-compatible endpoints (a local Qwen server, say) once, in
`providers.yaml` (`ProviderDeclaration` in `packages/owners/src/providers.ts`), and they reach every agent through
one conversion, `opencodeProviders`: the plugin's config hook merges them into the surface opencode's `provider`
config for owner chats and the operator, and `agentConfig` puts them into each sandboxed hire's
`OPENCODE_CONFIG_CONTENT`, since the sandbox masks the host's opencode config. An API key comes from a file under the
config directory's `secrets/`, read at load; it prints and serialises as `[redacted]`, travels only in the hire's
environment, and server output quoted in a hire error is redacted. Hires ask for their deliverable as JSON in the
reply text, never through a forced tool call. Built-in provider ids are refused (`provider_reserved`),
and `families.yaml` decides a declared model's family like any other.

### Provider health

A provider that stops taking onionsoup's credentials (an expired OpenAI key, a Copilot login that needs
re-authorising) fails every hire and chat on it the same way; on 2026-09-25 an OpenAI key stopped working and the
person learned only when an owner could not open a PR. Host code now says so. Every failed model call is classified
against `FAILURE_SIGNATURES` in `packages/owners/src/provider-health.ts` (HTTP 401/403, opencode's
`ProviderAuthError`, "Incorrect API key", `invalid_api_key`, "Unauthorized", "authentication failed", an expired
token, "Bad credentials"); rate limits and timeouts are not authentication. An authentication failure marks its
provider failing in `state/provider-health/<provider>.json`: since when, how many failures, the last few uses it broke
(hires by title, chats and decision watchers by owner) and the last error, masked (declared keys, `sk-…`, GitHub
tokens, bearer values and long base64 or hex runs) and clipped. The first failure of a spell logs one `[provider]`
line. The next successful call to that provider marks it `ok` with `recoveredAt`.

Hires report through `Runtime.hire` (the request's model names the provider); chats, plan sessions, subagents and
the watcher report through the plugin's event hook, from each assistant message's `providerID` and `error` (a
finished message without one is a success). The surface puts each failing provider in the inbox (`provider-auth`,
with a fix from `PROVIDER_FIX_HINTS`: `opencode auth login` for opencode's providers, `providers.yaml` for declared
ones) and in a red banner on every page; `/api/state` carries `providerHealth`, which also keeps a recovered provider
for `PROVIDER_HEALTH_LIMITS.recoveredShownMs` as a green confirmation. Detection is reactive: nothing probes a
provider that nothing is using.

### Wiki

The homelab wiki used to be an ordinary repository owner's domain: every edit was a plan, a desk change, a
cross-family review, a merge and a separate site publish, which was too much ceremony for a page of notes. The person
may now declare a **wiki** in `wiki.yaml` (`WikiDeclaration` in `packages/owners/src/wiki-config.ts`): its git
`repository`, `branch` (main), `pagesDirectory` (docs) and `keeper`, the one owner who writes it. The obsolete
`listen` setting is ignored by this release; leave it in a live configuration until the previous release is no
longer needed for rollback, because that release requires it.
The keeper must be a declared owner (`wiki_keeper_unknown`); no file, or one holding only comments, means no wiki.

Host code (`packages/owners/src/wiki.ts`, pages in `wiki-pages.ts`) keeps a clone at `<home>/wiki`, made on first
use. Reads come from its working tree: `list` (the page tree: index first, then frontmatter `order`, then title),
`read` (frontmatter and body), `search` (ranked by how many query words a page holds, then how often, a title match
counting more, with a snippet), `history` (git log, following renames) and `backlinks`. A page's title is its
frontmatter `title`, else its first `# heading`, else its file name. Frontmatter is YAML between `---` lines; `title`,
`order` (a number), `updated` and `sources` (a list) are read, and any other field is kept as it is.

Writes (`write`, `move`, `delete`) are the keeper's alone (`wiki_not_keeper`, checked in host code). Each one checks
the path (relative, `.md`, inside the pages directory, no `..`: `wiki_path_invalid`), the size
(`WIKI_LIMITS.pageBytes`: `wiki_page_too_large`), the frontmatter (`wiki_frontmatter_invalid`), and scans the page
and its reason for credentials (`wiki_secret_detected`): provider keys, GitHub tokens and private key blocks, the
refused shapes of the detector provider health masks errors with (`secret-shapes.ts`); long hex and base64 runs, URLs
and bearer examples are ordinary documentation and pass. Under a record lock (`state/locks/wiki.lock`) the change is
then committed with the keeper's persona as author (`<keeper>@onionsoup`) and the one-line reason as subject, and
pushed at once, so the remote is the backup. A push the remote refused because it moved is fetched, rebased and pushed
once more; a rebase that conflicts is aborted, the commit is kept in the clone (the content is never lost), the write
fails with `wiki_push_conflict`, and an attention item is raised for the keeper. Each write is journaled to the
keeper's notebook (`wiki-write`, `wiki-move`, `wiki-delete`); distill keeps page content out of the notebook.

Owners and the operator reach the wiki through `onionsoup_wiki { action, path?, to?, query?, content?, reason? }`,
its actions dispatched through a table (`wiki-tool.ts`). Every owner and the operator read; the operator's permission
allows the tool although it gets no other onionsoup tool, and subagents get none. A delete asks the person through the
`onionsoup_wiki_delete` prompt, which the surface's auto-accept never answers; write and move need no gate, since
every change is in git and pushed. Owners check the wiki before asking the person about homelab facts (the skills
bootstrap says so), and send the keeper corrections with `onionsoup_ask`, which lands in the keeper's chat.

The surface serves the wiki read-only under `/wiki/` on the existing localhost surface
(`http://127.0.0.1:4747/wiki/`), with no second listener. It is available only when `wiki.yaml` exists:
`/wiki/` is `index.md`, `/wiki/<path>` a page (`hosts/selfie.md` is `/wiki/hosts/selfie`),
`/wiki/search?q=` and `/wiki/history/<path>`. The wiki routes expose no write API; the main surface's chats and
approvals remain on their own routes. Pages are rendered on the server with marked (`wiki-render.ts`): raw HTML is
shown as text, only http(s), mailto, anchor and
site links survive, relative `.md` links are rewritten to site URLs, and headings get MkDocs' toc ids (old anchors keep
working) with a permalink. Each page shows who changed it last and when, a history link and the pages linking to it,
beside a sidebar tree and a search box. There is no script: one inline stylesheet (the surface's colours and fonts,
light or dark by `prefers-color-scheme`, laid out for phones too) allowed by its hash in the Content-Security-Policy,
whose `default-src 'none'` forbids every script. The site reads the clone's working tree, so the keeper's writes
show at once; it fetches and fast-forwards every `WIKI_LIMITS.syncMs` so pushes from elsewhere show up too.

`owners wiki migrate` moved the wiki off MkDocs once: the order of `mkdocs.yml`'s `nav` became `order:` frontmatter
(numbered in steps of `NAV_ORDER_STEP`, a nav title that differs from the page's own kept as `title:`), `mkdocs.yml`
was deleted, and the result was committed as the keeper and pushed.

### Safety

Every hire (owner decisions, surveys, answers, distillation, CI triage, reviews, conflict resolution) and every
verification runs in a memory-capped systemd scope (6 GB, no swap) inside bubblewrap with a read-only root; only a
conflict-resolving implementer writes, and only its worktree.
Nested core sandboxes reuse an inherited cgroup only when kernel cgroup v2 ancestry proves effective limits
of at most 6 GiB memory, 512 tasks and zero swap. They still run the identical bubblewrap command and private
environment; absent, unreadable or invalid proof starts the original systemd scope. Environment markers
are never budget evidence.

Owner chats and execution sessions are **not** sandboxed yet. They run in the surface's opencode on the host, and so
do the implementer and reviewer subagents they start: their bash runs as the person, limited only by the owner's
conversation rules, the session's rules and the subagents' permissions (see [gaps.md](../gaps.md)). Bash allowlists
are a convenience, never the boundary: the implementer may run any command its repository needs, except committing,
pushing, `gh` and `sudo` (landing is host code's job, and a sandboxed hire can still read SSH keys and the gh login).
A Go-only allowlist left from the first owner made implementers on other stacks spend their whole hire probing. Owners never get CLIs that can mutate their domain (for example incus):
host code snapshots evidence read-only, and effects happen only in host code after approval.

### Threat model: what a sandboxed process can and cannot reach

`~/.config/opencode` is loaded as plugins by any host opencode process that reads the person's real config —
the surface's own unsandboxed opencode is the one currently running: anything written there runs on the host,
outside any sandbox, the first time that opencode restarts. Every sandboxed process (`runSandboxed`,
`spawnSandboxed`, so workspace verification, shipping, distro smoke, hosted-site builds and hires) gets
a private `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`OPENCODE_CONFIG_DIR` under `ONIONSOUP_HOME` instead, bound writable
inside the sandbox; the host's real `~/.config/opencode` and `~/.local/state/opencode` are masked with
`--tmpfs`, placed after every writable bind so a requested bind cannot reopen them. Environment protection is
authoritative: those three variables are stripped from both the inherited and the caller-supplied environment,
then set last. A sandboxed opencode server is told to load the onionsoup plugin explicitly (a `file://` URL next
to the compiled or source module), since it can no longer find it through the now-masked global config.

What is still reachable in the sandbox, plainly, in one direction:
- **Masked:** the host's real opencode config and state directories (`~/.config/opencode`,
  `~/.local/state/opencode`) — this item's fix.
- **Still reachable, deliberately, until the credential-proxy follow-up:** `~/.local/share/opencode` (and
  `XDG_DATA_HOME` generally) stays writable, because `auth.json` lives there and hires must keep authenticating.
- **Still reachable, out of scope for this item:** the network (no outbound isolation yet), SSH keys, the `gh`
  login, and provider credentials in `auth.json` are all readable by anything that runs inside the sandbox.

A person (or the owner, from an unsandboxed shell) runs the sandbox's opt-in real-bwrap smoke test once by hand
before shipping a change to this boundary — the same shape as the ship action's person-approval gate, not a claim
the implementer or reviewer loop can make or corroborate.

## Lessons from building it

- Bash allowlists are not a sandbox: a "read-only" owner wrote probe tests with `cat > file` and ran one that
  allocated about 47 GB.
- Model claims are not evidence: host code runs verification, and the required review comes from another family.
- Handoffs lose context. A freelancer pipeline (planner, implementer, reviewer, each starting from a brief) kept
  losing what the owner and the person had settled; it was replaced by owners that plan with the person and carry
  out their own plans, handing subagents only small tasks along with the facts they need.
- Unrecorded findings are lost: owners write findings to a file as they work, journaled even if they crash.
- The notebook loop works: after rejections were distilled, the next survey re-proposed the rejected idea in
  the corrected form, skipped the rejected busywork and did not duplicate landed work.
- Deterministic checks first, then the owner: the rebase flow and app updates only wake a model when needed.
- opencode details that bit: structured-output sessions cannot be listed back over HTTP (1.18.32), and models
  sometimes send a list as a JSON string, so a deliverable is repaired where safe and otherwise asked for once more
  in the same session before it counts as failed; edit
  permissions match the path relative to the enclosing git worktree; an opencode started with a server password
  (the surface's) must not leak it into sandboxed servers; a sandboxed opencode's
  `OPENCODE_CONFIG_CONTENT` plugin entries are only resolved against a source path (not just any directory), so
  the sandboxed plugin is loaded as an absolute `file://` URL, not a path relative to the sandbox's cwd.
- TrueNAS details that bit: `truenas_app_get` answers with a list, and an app is `STOPPED` between its old and
  new containers, so updates follow the upgrade job, not snapshots of the app's state.


### Durable plan revision delivery

**Revise approach** retains the existing owner-plan ID, goal and approval gates. For inbox/manager revisions,
`state/plan-revisions` persists a prepared delivery record before changing the ledger to `planning` with the
person's feedback. A plugin pass under deployment admission recovers that transition, checks the current plan,
owner and exact original session, and submits one prompt with a stable message ID. Short cross-process claims
prevent concurrent submissions; no filesystem lock spans a network/model call. The goal and method are not canceled
by revision. Explicit cancellation or a superseding plan observed before dispatch suppresses old delivery.

An observed transcript message reconciles acceptance after a crash. A lost response, or an abandoned sending claim
with no transcript receipt, is **delivery uncertain**: the runtime never blindly sends again. It may subsequently
recognize the stable receipt, but otherwise requires inspection of the existing session. Missing origin, missing
persona and retired owner have separate blocker codes. A blocked revision that has never attempted submission
can resume automatically once its owner/persona and exact session return; an initially absent origin may be bound
from the unchanged work item's recorded session. A durable submission-attempt marker prevents prerequisite
recovery from turning an uncertain prior send into a fresh send. Each pass inspects at most 20 nonterminal records,
including blocked records. Blockers are visible in the inbox and owner/manager status;
use the item's normal cancel controls when stopping work. Delivery status is not evidence of revised-plan completion.

Already in-flight submissions cannot be recalled; cancellation prevents future dispatch and never rewinds external
work. The latest revision outbox is retained per item; prior human feedback stays on the work item. This is an
additive sidecar, with no old-notice backfill. Existing legacy work-notice delivery is otherwise unchanged.
Direct-chat plan feedback already returns to the active caller and keeps its existing synchronous path.

Revision blockers use a distinct informational inbox kind, so they cannot inherit attention Seen controls. Feedback also repairs an idempotent `plan-feedback` notebook entry after delivery; journal failure does
not prevent the prompt, and terminal records remain eligible for journal repair. Terminal delivery states cannot
be overwritten by late concurrent transport results. Directory read failures are reported without preventing
other notice systems from running.

A revision has its own durable identity; the transport message ID is minted and persisted only at dispatch.
It follows OpenCode's [native ascending ID format](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/id/id.ts)
and advances beyond observed native IDs in the target transcript. It is never regenerated after submission.
This avoids queue-time ordering ties without claiming that current transcript ordering relies only on IDs.
If no origin was present initially, pre-send recovery may bind only the unchanged work item's declared `session`
or `origin`; it does not choose another owner's current chat. Once pinned, the origin is never replaced.

The ledger's human notes remain the authoritative correction history. Journal repair covers the current revision;
if a later revision replaces an older record before journal repair succeeds, the older correction may remain only
in the ledger. This deliberately adds neither a second historical outbox nor legacy feedback backfill.

### Durable owner conversation history

Host-created and observed owner sessions are indexed in `state/session-history` by exact session identity, owner
and creation directory. Plan cleanup records those identities before removing the workspace and marks its
execution sessions archived afterward. Ledger origins and execution-session references also provide a read-only
fallback for older items; there is no title-based owner inference or automatic historical backfill. Only sessions
observed in an owner's exact directory and explicit item references are eligible. Conflicting identity claims
fail closed. The index contains metadata, not a transcript copy, and has no automatic retention deletion.

The surface discovers archived conversations after cleanup and restart. Existing workspaces use the supported
OpenCode API. Archived transcripts use the existing read-only SQLite adapter, first checking exact session ID
and stored directory. A missing transcript produces `history_transcript_unavailable`; ledger outcomes remain
available. This does not recover transcripts deleted from OpenCode or never-observed child sessions. The SQLite
fallback depends on the same versioned table layout as the existing hire reader.

Archived conversations cannot receive prompts, renames, aborts or auto-accept changes. Recreating the same path
does not reactivate a record marked archived by cleanup. Exact ledger-only terminal execution references also
remain history after their workspace retires; an active runner or retained execution context is not ignored
merely because its directory is absent. The UI shows archived conversations as read-only; **New chat** creates a fresh
session in the valid owner workspace. Addressed owner messages already use a host-proven fresh continuation;
new human chats do not automatically inherit selected historical context.
Ownership is checked before transcript access; an unknown session ID never falls back to an owner's desk.

Corrupt individual index records are skipped with metadata-only warnings; malformed or conflicting session
observations are not claimed. Exact authorization rejects an unreadable identity record rather than treating it
as absent. Index writes are best-effort when starting already-approved work: the ledger retains its session
reference, and metadata failure cannot stop its prompt. Cleanup still fails closed if it cannot preserve identity
before removing a workspace. Missing or incompatible transcript stores return the unavailable tombstone.

Surface session access requires an available history index. A whole-index read or write failure reports HTTP 503
`session_history_unavailable`, rather than silently hiding conversations or treating storage failure as missing
ownership. Malformed individual identities remain denied; directory ownership fallback is never widened by an
index error. Session creation checks index readability before contacting OpenCode, but a later storage failure
can still occur after creation and requires inspection. Approved engine dispatch keeps its durable ledger fallback
and does not depend on successful index writes. Recorded chat views are ordered by most recently updated.

### Verified attention conditions

New host-generated plan-worktree cleanup notices carry a condition identity scoped to the work item and its persisted workspace generation. Repeated observations update that one entry without undoing Seen. Successful removal (or verified absence) journals a terminal resolution before forgetting the worktree, so append failures remain retryable. The index retains a resolved tombstone even if it discovers completion before the original notice; delayed observations cannot resurrect that generation. Human decision notes remain attached.

### Decision-only human inbox

Host-authored `AttentionProvenance` is shared by journals and the attention index. Survey suggestions (in either
configured raises mode), worktree cleanup, failed/declined delegations and keeper maintenance
are owner backlog, not requests for a person's decision. Review exhaustion and explicit CI person dispositions
remain human decisions. Ordinary engine approvals, questions, permissions and uncertain request recovery keep
their existing gates and read-error behavior. This routing creates no new approval or execution authority.

On the first routing upgrade, discovery replays journal cursors once, preserving stable card identities and all
human decision receipts. Legacy classification requires the original journal record plus its exact old host
envelope and related persisted records: worktree path/item or delegation request/participants/work item. Only the old work-mode survey envelope identifies a suggestion; ambiguous free-form
attention and missing source evidence remain conservative human choices. There is no semantic prose guessing.

Reconciliation updates only the attention index, never source journals, requests or worktrees.
Filesystem `ENOENT` positively clears an absent worktree notice; unreadable paths fail the snapshot, not silently
resolve. Existing worktrees and unpublished commits remain intact.
A linked request completion, recorded cancellation or cancelled linked work item clears delegation failure cards;
a similarly worded replacement's success alone proves nothing. Human acknowledgments and original observation
times are preserved. Cleared entries remain history across restarts; old cards are not deleted or replayed as work.

App-update failures instead carry typed request-operation provenance (`update-app`, execution phase).
Both participant alerts retire only when that exact update request records host-confirmed `updated` success.
The exact older host failure envelope can correct formerly misclassified delegation provenance without
guessing from model prose. Interrupted-effect recovery remains a separate genuine gate; alert retirement
neither approves a retry nor erases its history.

Assignment completion does not prove unrelated underlying conditions cleared. The explicit fact/decision tools
construct fixed journal shapes and cannot accept host routing or condition metadata. The index trusts the
host-owned journal; this is not a new filesystem security boundary. A recreated or newly adopted worktree
receives a new generation key persisted before creation, so a crash cannot reuse a resolved generation.
