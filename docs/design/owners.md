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
- **Conversation mode**: per-pattern `allow` / `ask` / `deny` rules for chats. Repository-changing owners
  have local edit/development conveniences in their already-authorized workspace; explicit declared denies
  override them, including for delegated descendants. Unlisted commands still ask. These conveniences are
  not shell containment: chat bash remains an acknowledged unsandboxed gap.
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

Previously quarantined exchange notices remain quarantined. Reminder dispatch remains persona-gated, including
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
- `onionsoup-reviewer-<owner-id>`, one per owner: read-only (no edits, read-only bash), with the first `review`
  freelancer model outside the owner's family.

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
review/reset or operator exact-file/two-acceptance protocol for owners. The item
records the session (`session`). A plan approved in chat opens its session at once; one approved from the inbox, the
CLI (`owners approve`) or by a manager stays `working` without a session, and the plugin opens it on its next pass
(every `PLUGIN_LIMITS.noticeMs`). The plugin holds the opencode client, so sessions open only while the surface runs;
`openNeededSessions` in `owner-sessions.ts` retries a failed open on the next pass.

**Intentional pause, not crash interruption.** A human Stop in a linked work conversation or a work item's
Pause control first records `pausing` and an actor-bound receipt, fencing new dispatch. Host runners keep
their claims until the admitted effect reaches its real checkpoint. The plugin stops the recorded execution
tree and positively observes it idle before recording `paused`; unknown openings, children or stopping
receipts remain `pausing`, never falsely settled. Delegated requests project `work-paused`, and paused work
does not reserve an otherwise idle owner or reopen through daemon recovery, notices, reminders or peer messages.
Only an exact host-recorded work session is stopped or fenced, never a shared desk/chat origin. Work without
an execution session pauses without stopping its submitting conversation. A positively created but
never-prompted opening retains its identity so a racing pause can settle. Explicit resume delivers its original
stage workflow prompt through a durable notice; an uncertain introduction is reused, never blindly replayed.

Explicit Resume restores the saved stage and unchanged goal, plan, approval and checkpoints without another
plan approval. The host records who resumed and why; model prose or an actor name cannot supply authority.
A configured direct manager may resume work she requested only under the report's applicable `approve-plans` grant.
Messages remain queued while paused. Work execution sessions and observed children remain read-only until resume, so a
continuation or a publication tool cannot accidentally restart deliberately stopped work.

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
its PR merged (or an exact accepted repository-closure receipt). Operational work uses its own host-observed
checks and effect postconditions, never a fabricated PR. The worktree outlives the merge: the plan's session often keeps working there after its PR merges
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

**Operational completion without a PR.** `onionsoup_complete_work { item, action: "complete" }` completes an
approved delegated operational goal from its host-proven execution session or original-work continuation.
It requires unchanged original request, goal, plan and approval; a clean published source; configured sandbox
checks; and one final review from a configured different model family against the actual original goal and
host evidence. Existing resource requests are discovered from exact observed execution lineage, never a
model-supplied list of resource IDs. Supported Incus effects require retained creation checkpoints, request-tagged
managed identity, create/delete approvals, any required successful host follow-up and positively observed deletion
across projects. Completing work does not create resources or bypass effect gates.

The original `ResourceRequest.operation.checkpoint` stores the verified completion receipt before the ledger
and request projections. Retries repair only those exact projections and queue one requester notification,
using the fresh correctly owned continuation when its original workspace retired. The work lands without a
publication and the request completes without the PR-specific human closure ritual. Repository changes,
dirty/unpublished commits and existing publication evidence still require their normal publication lifecycle.
Model reports alone, foreign identities, failed checks or unavailable postconditions never establish completion.

`onionsoup_complete_work { item, action: "reverify" }` instead queues concrete owner re-verification in the original
work context, retaining its goal and authority. Insufficient legacy records remain missing evidence; the owner
must obtain real original-session resource/check receipts and supported postconditions. No transcript claim,
fake merged PR, new human attention card or automatic replacement VM supplies that proof.

**Draft publication and external PR recovery.** `onionsoup_propose_changes` accepts `draft: true`
(`owners propose <owner> --draft --item <item> --note <title>` in the CLI). The saved publication
mode survives retries; a conflicting retry is refused. Draft mode creates a draft PR, checks that
GitHub still reports draft with auto-merge disabled, and suppresses grant-based merge and site
follow-up, including resumed checkpoints. It does not grant merge authority or make a PR ready.

A person can reconcile an already published PR with
`owners reconcile-pr <owner> <item> <https://github.com/owner/repo/pull/number>`.
This command only accepts an approved, working request item with its existing clean plan worktree.
It binds the configured repository and base branch, the request and item, and the exact local/remote
head. An open PR must be draft with auto-merge disabled; a merged PR must have a merge commit in
the configured base history. Host verification runs afresh on that source, and the ordinary
cross-family reviewer receives the original goal, acceptance criteria and tree-bound check evidence.
For merged PRs, the review base precedes the merge so the change cannot disappear from the diff.
Only after a second source and GitHub check does the command append implementation/review evidence
and link the PR. It preserves original intent, plan, approvals and history. Repeating the same
link does not duplicate evidence or publication. Existing request tracking observes merged state
on its next pass; reconciliation never creates a PR, pushes, merges, publishes a site, or claims
deployment. Closed-unmerged, mismatched, dirty, active or unapproved work is refused. There is no
bulk backfill or owner tool that can self-attest an external review.

To record only the historical fact of a merged PR, a person can instead use
`owners observe-merged-pr <owner> <item> <url>`. It accepts an approved, idle, working request
with a clean plan worktree at the exact PR head. Host metadata must match the configured repository
and base, and the merge must be in that base history. Source, remote metadata, request and work item
are checked again before recording. This command neither runs verification nor hires a reviewer.
It appends an idempotent observation with the observed head/tree, merge/time, base, actor and plan
binding. Matching current host attempt evidence is preserved as a separate snapshot, including
revise findings that remain follow-up; historical reviews are never rewritten. Missing evidence
is not approval, and mismatched evidence is refused. Request-scoped status distinguishes the fact
from acceptance. Observation leaves publication, blockers, goal, plan and request completion
unchanged and never creates follow-up work. A later review does not rewrite the observation;
explicit acceptance still governs completion. There is no bulk historical import.

**Closure after follow-up fixes.** `owners prepare-request-closure` verifies a separate clean checkout
at the configured base tip, the original observed merges and the explicitly selected merged follow-up
PRs. It binds the original request, goal, plan approval, review history, configured checks and exact
integrated commit/tree. Host verification and a fresh cross-family review assess the original acceptance
criteria and give every historical finding an explicit evidence-backed disposition: fixed, or outside
the original approved scope. Review failure cannot be accepted. The new review has its own history;
it never changes the old verdict, historical merge observation or request-scoped attempt evidence.

Preparation produces a durable candidate, not completion. The person inspects it and runs
`owners accept-request <owner> <item> <digest> --note <rationale>`. Acceptance rechecks freshness,
scope, configuration, source and GitHub facts before committing under request then ledger locks.
Verification and model execution happen outside those locks. A competing plan revision, cancellation,
runner or changed request invalidates the candidate. Evidence has a 24-hour default lifetime, controlled
by the repository’s optional `requestClosureEvidenceMaxAgeMs`; advancing the configured base also requires fresh preparation.

The append-only acceptance receipt records the person, rationale, exact candidate and timestamp.
It moves the work to landed without inventing a publication or replacing old findings. The linked
request becomes completed from that receipt; if interrupted between those writes, the same acceptance
command or normal delegated-work tracking repairs only the matching request projection. Identical retries
preserve the receipt and completion timestamp; conflicting acceptance is refused. Coordinator and surface
views distinguish current acceptance from historical revise evidence. This is a host CLI capability with
the existing trusted-person boundary, not a model tool, persistent grant or general outcome system.
See the [closure commands](../extending.md) for invocation and operational prerequisites.

**Repairs on the desk.** The `maintain-prs` duty keeps published PRs mergeable and green. Failing CI on a new head
commit hires the owner once for that commit to decide fix, flaky or person; no work item is opened. `fix` wakes the
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
records them as unavailable), and only observed failed
tool events, never raw arguments. Host-side records under `state/friction` are bounded and deduplicated by a
versioned owner/tool/error-class signature; when no failure event was observed, prose-based matches are marked
provisional. Each submission journals a short `friction` activity entry, and a new signature leaves one durable
pending wake intent. The surface lists these reports and links to the first reporting chat. Capture itself never dispatches work. Optional `friction-triage.json` in the config directory declares
`{ "version": 1, "owner": "maintainer-id", "repository": "org/repo", "enabledSince": "ISO timestamp", "intervalMs": 3600000 }`.
The owner must own that repository. With no file, triage is disabled. A configured daemon considers only reports
first seen on or after the cutoff, among the most recent 100 reports. It schedules at most one read-only
investigation per interval (minimum one minute), after existing requests, due duties and runnable items, and while the maintainer has no reserved,
runnable or running work. Admission and owner reservations keep it off deployment and existing worker paths.

Before diagnosis the host collects a bounded incident bundle from declared roots and typed persisted records.
It includes linked work and rebase siblings/rejections, request/effect checkpoints, host checks/review summaries,
session identity/archive facts, owner schedules and duty timestamps, provider health, declared models/families,
remote and credential **references**, maintenance/admission summaries, installed/configured build facts and
safe local Git head/history/base/containment. No credentials, environment-file values, raw runs, transcripts or
private tool output enter the bundle. Fixed host argv and configuration select paths and commands; reports
and model output never do. Missing/unreadable facts have explicit reasons, and abbreviation is visible.
The installed collector identity and configured deployment target are not live-service/plugin attestation;
local source and Git history are explicitly not fetched.

A sandboxed owner hire still has shell access denied. It receives the bundle before inspecting source and returns
observed/inferred/unknown facts and either a bounded proposed fix, missing evidence, no action or positive closure.
A versioned sidecar in
`state/friction/investigations/<id>.json` holds the claim, result, session and cost. Unreadable wake/sidecar candidates are skipped with a diagnostic naming the report, so another valid report can proceed.
The surface shows unavailable investigation status on a corrupt sidecar while preserving other reports. Original reports and pending wake
files stay compatible; the sidecar is the processing status. Repeated discoveries adopt the saved result. A crashed
claim becomes `blocked: friction_triage_delivery_uncertain`; inference failures stop without automatic paid retries.
The cadence timestamp is durable before dispatch; a crash there may delay dispatch by one interval. The underlying
hire has the existing timeout and structured-output fallback/resend behavior; this is a dispatch bound, not a dollar cap.

The Friction list/detail shows processing status and the proposed fix with its evidence; no new inbox item is created.
`owners friction-investigation <id>` reads the effective triage, revision, local freshness and current approval digest;
`originalTriage` separately retains the original evidence. Stale or already-fixed results have no approval digest. `owners friction-triage <id>` explicitly investigates one
selected eligible wake under the CLI runtime lock (it cannot run beside the daemon). This operator command bypasses
the daemon cadence but cannot repeat a saved/uncertain investigation. Diagnosis never edits code, publishes issues
or invents authority. Missing operational evidence remains owner incident follow-up in the desk and
`onionsoup_status` (`friction=<id>` reads its bounded evidence), never a new person Attention card.

Under the existing opt-in policy, eligible, current `propose-fix` diagnoses route automatically through the
configured owner's normal work acceptance, planning and publication workflow. The request is typed
`ownerFollowUp`, not a person assignment or fabricated manager approval. No new grant is supplied.
`routeProposals: false` retains explicit manual routing. Routine promotion needs no person relaying facts;
actual plan/effect gates and applicable standing grants remain unchanged.

The person's **Request this fix** action promotes the displayed proposal, bound to its digest, into an ordinary
human-attributed work request. `owners friction-promote <id> <digest>` does the same; the read command above supplies
the digest. A durable intent in `state/friction/promotions` stores who requested it and the exact proposal before
routing. The source friction ID determines one request identity. Repeated clicks, process restarts and lost replies
adopt that request's current status; cancelled, declined and completed work never reopens. Receiver acceptance,
plan approval, verification and effect gates remain intact. The Friction view links the responsible owner and work,
and shows request status separately from verification that the original friction is fixed.

An investigation records the source commit it read. Before promotion, and again before routing a saved intent, host
code compares that commit with `HEAD` of the policy owner's clean local checkout. The comparison is local only: it
never fetches, and the Friction view labels it "local checkout, not fetched". A different commit means the proposal
needs revalidation, never that it is fixed. A dirty or unreadable checkout is `source_unavailable`:
promotion refuses it without saving an intent, while a saved pending intent consumes a bounded routing attempt
and retries on the normal recovery cadence without opening a request. A changed commit or proposal blocks a
pending intent with `friction_source_stale` until revalidation and fresh approval. An existing request is never replaced.

`owners friction-revalidate <id>` explicitly re-investigates a source-stale report.
`owners friction-refresh <id>` also refreshes completed diagnoses at the same source commit when host evidence
changes. The lowest-priority daemon worker uses the latter path under the same cadence/reservation rules.
A write-once evidence-generation claim binds source and bundle digest; unchanged or previously attempted
generations do not consume another model call. A failed hire or a dead runner leaves the claim `failed` or
`uncertain`, and ordinary revalidation never replays it. Unknown transport/in-flight outcomes hold later
generations, not just the identical digest. Host-returned terminal assistant errors or invalid deliverables
stay failed history but allow one diagnosis for materially new incident facts, without a person reset.
Routine duty/journal/session timestamps remain context but are excluded from refresh identity; actual
schedules, linked conditions/status/check/effect identities, source/containment, provider health status and
recurring captures can change it. A post-closure recurrence invalidates the effective closure, returns to
owner backlog and becomes eligible again; original closure history remains.
Resolved linked journal conditions are scanned since the capture under a shared byte/file budget, before
the short context event tail. Routine events and day rollover never age a receipt out of that tail.
An abbreviated scan is explicit, never evidence of resolution. Duplicate links are capture-generation-bound:
a recurring duplicate after its primary closes returns to follow-up; a still-unresolved source can be relinked
with an append-only host-only revision and no invented model findings or extra hire.
Results are appended as write-once revisions under
`state/friction/investigations/<id>/`, published atomically; the original investigation is never rewritten. The
latest `revised` revision is the effective proposal, and its digest includes the revision number, so a revised
proposal needs fresh approval. A blocked intent that never routed is archived as superseded history before the new
approval routes; the report still has one request identity. Revision publication and the final effective-proposal,
freshness and approval checks through request creation share a per-report kernel lock, across CLI, daemon and
surface. Revalidation model execution stays outside that lock. A revision published first invalidates the old
approval; a request created first remains the one durable request. This lock does not control external Git
checkout changes; freshness remains a clean local snapshot, not an atomic remote-source guarantee.

A person may authorize one additional attempt with
`owners friction-revalidation-retry <id> <reference-commit> <failed-claim-token>`. Read the token from the saved
failed claim returned by `friction-revalidate`; this command acknowledges that a generic failure does **not**
prove the earlier hire made no inference. The command binds that token to the current clean reference commit,
records that commit and the local person's username, and archives the exact failed claim bytes before replacing the claim under
a lock. Repeating the same command returns its saved retry; a failed retry cannot gain another attempt. A crash
between archive and replacement resumes only when the archive exactly matches the failed claim. Running,
uncertain, malformed claims and existing revisions for the commit block new hires. A dead retry becomes uncertain.
The retry is a human CLI operation under normal admission, with no model tool, daemon retry or backlog replay.
Initial and retry launches check that an executable `opencode` resolves in the hire's PATH before consuming an
attempt; this filesystem check does not prove the sandbox, provider or inference will succeed. Correct the calling
process's PATH to the existing installation before retrying. Older binaries reject retry metadata as uncertain,
preserving the fail-closed rollback boundary. Original reports, investigations and revisions are retained.

An `already-fixed` answer needs a `fixedBy` commit contained in the reference history **and**
`conditionEvidence` keys naming applicable positive host postconditions in the collected bundle.
Supported conditions are linked original-goal host verification/acceptance, completed verified operational
checkpoints or exact linked host condition-resolution receipts after the report. Mere source presence,
source citations, model prose, request routing or a merged PR alone never retire friction.
Unsupported initial closure becomes `needs-evidence`; unsupported revalidation is saved `blocked`
(`friction_fixed_by_unknown`, `friction_fixed_by_unreachable`, `friction_operational_condition_unverified`)
and does not replace the effective findings. An effective already-fixed result offers no
**Request this fix**. The Friction view shows both commits, every revision including blocked ones, the original
investigation, superseded intents, and any history that could not be read.

Routing retries saved intents, at most three attempts per routing budget (up to 20 pending intents per
tick), then stops with a visible reason. **Retry request routing**, or
`owners friction-promotion-retry <id> <digest>`, explicitly resets an exhausted routing budget after rechecking the
captured recipient's current repository scope. It never resets an existing request's execution or terminal status.
Original reports and Attention Seen receipts are never rewritten or treated as work assignments.
Disabling policy stops new discovery/routing; it does not cancel an already running read-only hire or
an already-routed request. No policy is installed
by an upgrade; choosing an activation-time cutoff preserves legacy pending wakes for separate approved backfill.
For an authorized legacy diagnosis, `friction-refresh <id>` adds evidence/revision history without rewriting
the original capture, paid claim or Attention decision. Exact duplicate symptoms with the same host-linked
source incident are source-linked rather than diagnosed/routed twice. Repeated `owner_abandoned` rebases
also require the same demonstrated original PR/head/rejection condition, not simply matching PR numbers.
Different symptoms remain separate, and duplicate linkage is not a closure claim.
The deterministic PR maintainer now honors a recorded `owner_abandoned` rejection for the exact original
item/previous head, like an existing cancelled rebase. It does not repeatedly create the same unwanted update,
close the remote PR, blacklist ordinary errors or suppress maintenance when the remote head changes.

### Requests between owners

Owners ask each other questions (`onionsoup_ask`: answered from the other owner's notebook and fresh evidence,
split into observed, inferred and unknown). Both owners journal the exchange (`asked`, `answered`) and see it in
their recent activity; no chat is posted a copy. Exchange notices already in the queue still go to the owner's
latest person chat, discovered from existing nonchild sessions and persona user messages. The plugin
waits for that chat to be idle, then posts with `noReply`; the decision watcher skips runtime notices. No person
chat means the notice stays pending. A pinned destination and stable message ID reconcile a post accepted before
a crash; transport failures retain the queue entry. Full exchanges remain in `notices/exchanges` under the state
directory, and shortened notices cite their record ID. Delivery records preserve the exact rendered text and
agent; acceptance reconciliation requires that exact persisted message, not its ID alone. An expiring host-only
delivery capability exempts the informational post from chat-turn admission while a bounded delivery lease
protects the post itself. Genuine messages retain normal gates, even when they copy notice text. Completed
real turns can ignore exact delivered notices at their tail; old stranded admissions need the separate
[operator recovery procedure](../deployment.md#recovering-admissions-stranded-by-informational-notices).
Owners also open requests to each other.

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
| `instance` | any → incus owner | person approves create (optionally the delete too), runtime creates, follow-up runs, delete |
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
she sent: `cancel` cancels it (its request then fails, and only that request), `note` leaves the report a note, and
`resume` resumes it after an intentional pause under the report's `approve-plans` grant. Every action takes a note and
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
Each OpenCode plugin instance owns its maintenance timers. Its `dispose` hook stops all three timers,
shares cancellation across maintenance reads, and returns after a bounded wait. A transport that ignores
cancellation still owns its admission until its underlying promise settles; a timeout is not completion.
Maintenance admissions carry instance, operation and directory identity. The latest operation record for
each instance/kind in `state/plugin-maintenance/` records its phase, pending or uncertain SDK calls and
settled/released status. Uncertain passes are archived before a later pass runs; their admissions remain
held, while exact domain claims prevent replay and unrelated maintenance can continue. This is
maintenance evidence, not proof that a chat or child completed.
Legacy admissions without operation identity have a separate exact-digest interruption procedure.
It preserves their unknown outcomes and original records, verifies the original process groups stopped,
and starts only a target that acknowledges the durable quarantine before effects. In that mode the
daemon and surface serve diagnostics; OpenCode, chats, dispatch and mutations remain disabled.
Attempt records prevent uncertain stop/start replay. Failed activation never restarts an older build
that cannot enforce quarantine. The ordinary deploy worker refuses the held checkpoint. A separate
operator-only release command inventories replay candidates and requires fresh exact-digest approval.
It starts OpenCode in observation mode, keeping execution, MCP servers, notebook initialization and
wiki synchronization blocked. Inert terminal request history can retain its operation and checkpoints
when no runner remains; this does not attest the historical outcome. Existing single-use-protected
continuations also qualify. Future reminders qualify only before their due time, bound into the proof
and checked again at release commit. Interrupted operations, tracking requests, finished-worktree cleanup
candidates and unsubmitted actionable wakes still require separate evidence. After authenticated quiet proof,
the host disposes restricted instances once and commits release before normal instances can load.
Original outcomes remain unknown in immutable archives; no lease, transcript or domain status is cleared.
See [legacy recovery](../deployment.md#legacy-maintenance-recovery-plan).
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

### Operator

Owners each hold one domain under gates. Some work belongs to no domain: operating onionsoup itself, reading across
every owner's records, a one-off job on the homelab. For that the person may declare an **operator** in
`operator.yaml` (`OperatorDeclaration` in `packages/owners/src/declarations.ts`; the agent in `operator.ts`): one
agent the person directs turn by turn in a chat of its own, like a coding agent in auto mode. It sits outside the owner
rules on purpose. It owns no domain, keeps no owner notebook, runs no duties, and is woken by the runtime for its
own investigation jobs and the memory nudge below; owners cannot
reach it (it is in no roster, and `onionsoup_ask`, `onionsoup_request_work` and friends resolve only owners). Its id
`operator` and its name are reserved: no owner may take either (`operator_reserved`).

Its permissions allow nearly everything: any bash, edits, the web, any directory, subagents and questions. Only
`OPERATOR_ASK_BASH` asks, plus the person's own `ask:` patterns: recursive deletes, force pushes, hard resets and
`git clean`, deleting incus instances, destroying ZFS datasets and pools, `mkfs`, `dd`, `kubectl delete`, and the
CLI's person gates (`owners ... approve*`, `owners ... ship*`), so it does not answer an owner's plan or ship for the
person unasked. It gets no `onionsoup_*` owner tools (they are denied, and refuse any agent that is not an owner)
except `onionsoup_wiki`, with which it only reads the [wiki](#wiki), and `onionsoup_operator_job` for its own investigations. It cannot submit, approve or ship owner work through them, and the plan-approval, ship and owner-change prompts of owners'
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

#### Durable operator investigations

`onionsoup_operator_job` supervises the operator's own children, independently of owners. It supports
read-only investigations, explicitly approved edits and new text files, and scoped host-run checks. Children have no arbitrary bash, native
edit, network, delegation or owner tools. No persistent grant is created; the operator's normal interactive permissions
are unchanged.

The host binds a job to the configured operator and exact top-level chat, and captures the invoking human message
from the transcript. Original intake, decomposed goal, constraints and task scope are separate fields; a runtime
notice cannot create a new job as if it were a person. `create` returns a durable handle promptly. Tasks name existing
directories within the operator's configured workspace, use `access: "read-only"` or the gated `"write"` scope below,
and can name `dependsOn` task IDs.
The scheduler reserves at most two managed slots across all jobs. These are independent OpenCode sessions with logical
parentage in `state/operator-jobs/jobs.json`, so the parent can answer another message while both children run.
Children are also recorded in the operator's existing session history, without inventing native parent relationships.

Use `list` or `show { id }` for status, exact child sessions, attempts, events and transcript evidence. `pause` stops
new dispatches while existing investigations continue. `cancel` aborts only the bound child turns and preserves their
records; uncertain dispatch or changed turns block cancellation, rather than claiming it succeeded. `resume` restarts
scheduling; with `childID`, it resumes a proven interrupted read-only turn in the **same** session using a new durable
attempt. Restart reconciliation never launches a replacement for an uncertain creation or dispatch. Idle runtime
status alone is not evidence of completion.

Runtime calls run outside ledger mutation locks. Short durable operation claims reserve capacity before effects;
returned observations and acknowledgements apply only to their matching claims. Parent controls fence stale actions
without treating a sibling's progress as a change to the whole job. Each client operation shares one aggregate
10-second transport budget, and a scheduler pass uses a shared 20-second budget with at most 16 observations.
An expired operation claim permits observation of its receipt, never reissuing the uncertain effect. Parent create,
pause and synthesis calls can proceed while metadata reads wait.

Unknown outcomes keep their reservations during bounded observation (three attempts or two minutes, with 15-second
spacing by default), then stop automatic polling with `needsDecision`. `recheck { id, childID }` performs one fresh
observation without dispatching work. If the receipt appears, it reconciles the existing session. Otherwise,
`recovery-preview { id, childID }` shows the exact scope and digest for a read-only child;
`abandon { id, childID, digest, text }` requests a one-time human decision. Write reservations qualify only with
zero recorded mutations and the stronger runtime proof described below. It is never an automatic retry or a claim
that the original work failed.

Abandonment releases only the logical scheduling reservation. The old inference may still finish, so physical
concurrency may temporarily exceed the two managed slots after this explicit decision. The unknown outcome remains
visible: no fabricated end timestamp, completion, or accepted result. The child remains permanently fenced against
future prompts, tools, resume and dependency completion. Late acknowledgements are retained on that record without
resurrecting it. No replacement is created; a replacement requires a separate explicit user request.

Recovery requires a matching native permission request **and reply**, bound to the parent session, tool message,
host-generated nonce and exact recovery digest. Only a native `once` reply is accepted; `always` is rejected even
though the request offers no persistent patterns. An automatically allowed `ask()` is insufficient. Surface auto-accept
excludes this gate, and its UI offers only a one-time decision. Known foreign work remains protected through later
failed reads: recovery inspection records a protective blocker if it first discovers that evidence, without changing
the runtime or attempt history. An observed busy runtime without a receipt is not eligible. Rejection, abort, changed scope, new foreign work or
a receipt discovered during approval leaves the reservation intact. No standing grant is added. Duplicate approved
calls preserve the first audit receipt. Native permission prompts do not survive a runtime restart; ask again if
the runtime stopped before committing the recovery.

The plugin has a separate admitted operator maintenance pass, so slow operator metadata cannot hold up domain-owner
notices. It reconciles jobs and sends durable, actionable parent wakes for progress, blockers, write review and readiness.
Wakes wait for an idle parent, keep a stable message receipt and never blindly resend an uncertain
prompt. They are runtime observations, not new permissions. The operator must inspect current job state before acting.
Completed child evidence retains exact session, prompt, final message and tool-call identities. `synthesize` takes the
current job digest, all final evidence message IDs and the operator's explanation, then completes the job once. This
binds the summary to observed transcripts; it does not certify the truth of a model's conclusions.

`prepare-handoff { id }` builds a separate combined preview only after all children are complete and writes are
accepted. It requires one Git repository, one exact base and baseline manifest, and disjoint approved paths. It
retains original intake, constraints, child evidence, approvals and exact diff provenance without modifying a job,
worktree, commit or synthesis. `check-handoff { id, digest, checkID }` runs one of the already approved Node/Go
commands on the private combined source snapshot. Identical commands are deduplicated with every original check
recorded as provenance; more than four distinct commands is refused rather than silently dropping checks.

Combined checks have their own durable ledger and deployment admission, with at most two prepared checks globally
and one per handoff. They run asynchronously outside mutation locks. A prepared check is never replayed: known exits
(including setup failure) produce reusable receipts, while unproven process termination retains admission and an
uncertain record. Restart preserves that uncertainty; there is no automatic retry or claim that a crash undid work. Evidence-bound recovery is described below.
`show-handoff { id }` rechecks live child evidence and workspace freshness and provides an exact patch and JSON report
under `state/operator-handoffs/`. Reports are timestamped observations; call `show-handoff` after a pending check to refresh the exported JSON. `ready` means all configured combined checks passed for the current artifact;
`unchecked` means none were configured. Neither means applied, independently reviewed, committed or published.
The human's existing exact scope/check authorization covers these commands; preparing or checking a combined preview
does not add another permission click or standing grant. Applying requires its own exact destination approval; publishing remains separate user-directed work.

`preview-application { id, directory }` binds that ready result to an exact clean sibling integration worktree in
its canonical Git repository. Its application digest retains the original goal/intake/constraints, accepted child
identities and evidence, successful combined-check receipts, destination HEAD/index and full filesystem baseline.
`apply-handoff { id, directory, digest }` uses the existing native write gate with **Allow once** for this destination
effect. Exact retries reuse that saved approval; a different destination/digest is rejected. No standing grant,
commit, push, merge or publication is added. `show-application` and the handoff report expose separate application
progress and durable evidence, without rewriting child acceptance or synthesis.

Applications reserve the whole canonical target in the same jobs transaction used by child workspace claims. Held
claims survive pause/cancel/restart and conflict with readers and writers in either direction. One dedicated
cross-process execution lock serializes application workers; metadata reads and file execution never hold a jobs
or application mutation lock. Parent tool calls return promptly after durable approval, while ordinary maintenance
reattaches to existing approved/in-progress applications. Blocked attempts need an explicit exact retry.

For every file the host saves preparation intent, creates and fsyncs a bounded private staging file, then saves its
exact identity before execution. A fixed sandbox publisher waits for an explicit permit after the host durably saves
its launcher/PID-namespace witness. Existing files are written through pinned descriptors, retaining their inode;
new files use no-overwrite hardlink publication from staging in the same parent. A completed postimage is durable
evidence only with the exact original/staging inode and birth time plus positive stopped-process proof. The observed
result is saved before identity-checked stage cleanup and final receipt. Recovery reuses this history: completed
writes are never replayed, untouched preimages can retry at most four times, and partial/foreign/unproven outcomes
remain reserved. Interrupted staging before its identity was saved also remains blocked, without blind cleanup.

After all receipts, the host revalidates unchanged HEAD/index, the entire target source against the approved combined
source digest, and original live child evidence. It records `applied` before releasing the exact claim and admission.
Crash recovery completes only remaining identity-bound cleanup. Managed claims do not exclude an unrelated editor;
identity/content changes are detected and fenced, but this is not a filesystem-wide transaction. A multi-file partial
application is retained for inspection rather than represented as rolled back or complete.

Combined-check recovery uses `recovery-preview-handoff { id, receiptID }` and
`recover-handoff { id, receiptID, digest, text }`. Each new attempt persists its exact admission, command/artifact
binding and process identity domain before it occupies a check slot. A separate, checksummed execution journal is
saved before launch. The sandbox runs a fixed host guard which requires an explicit permit byte; EOF never starts
the approved command. The host saves the verified namespace/launcher witness before sending that permit.

Recovery inspects process identities outside ledger locks and rechecks the exact job, receipt and journal digest
before committing. A saved host outcome can be reconciled without a new approval. When execution is positively
stopped but no outcome was saved, the existing native **once** gate asks the person to release that exact reservation
as `stopped-unverified`. An exited original host with an intact pre-launch journal and no execution witness also
proves that the guarded command was never started. Neither case invents an exit code, reruns the check, accepts the
combined result or rewrites prior synthesis. The original prepared receipt remains, alongside an immutable resolution;
late outcome facts stay in the journal without replacing a human unverified resolution.

Resolved receipts stop consuming the two combined-check slots, but their check IDs stay consumed. Cleanup deletes
only the exact recorded admission identity and can be retried idempotently. Source drift still makes the handoff
stale, but does not prevent releasing a positively stopped resource. Running, zombie, foreign or unreadable identities,
changed boot/PID domains and missing legacy provenance remain ineligible. No process is killed by this recovery path,
no broad lease clearing occurs, and no standing permission is created.

The acceptance scenario is two parallel investigations, another message answered in the same parent chat, a restart
of a disposable OpenCode server, recovery of the same child IDs and evidence, and a recorded synthesis. Production
sessions must not be restarted to test it. Native permissions and canonical-path checks constrain reading tools, but
these host sessions are not a filesystem sandbox against concurrent path replacement by another process.


#### Scoped operator file edits

A write task uses `access: "write"`, `files` for existing tracked UTF-8 files, and optional `createFiles` for exact new
text paths. Its directory must already be a clean Git worktree root under the configured operator workspace. New files
require existing parent directories and absent, nonignored paths; deletions, symlinks, hard-linked files and Git metadata
are excluded. Default limits allow eight approved files per task, each
at most 256 KiB. Creation captures the original intake, goal, constraints, existing/new paths, check commands and HEAD in an exact scope digest.
The person must answer the matching native **Allow once** prompt before the job is admitted. Auto-allow, **Always**,
a runtime notice or approval for a different task cannot substitute for this decision. Retrying the exact same bound
`create` reuses its durable approval and child identities; it does not ask again or create another job. A natural-language
request alone does not authorize inferred paths or commands. Removing the initial click requires a separate structured
intake and authority decision; this slice adds no persistent grant.

Workspace claims cover the whole canonical worktree, including overlapping parent/child directories. A conflicting
read or write task is refused rather than run concurrently; two independent worktrees can use the two managed slots.
The operator can keep answering its parent chat while these children work. Claims remain held after child inference
finishes and until the person accepts the verified diff. Claims coordinate managed children, not external programs;
use dedicated worktrees. Host checks cover tracked files and nonignored untracked paths. Ignored untracked files remain outside
that integrity check, and no child can create or edit ignored paths through this tool.

The child calls `onionsoup_operator_write_file` with an approved relative path, its expected current SHA256 and full
replacement text. Host code records a mutation intent, checks the original Git and file identities, and passes a
pinned file descriptor to a fixed writer in a network-isolated, memory-capped bwrap sandbox. The helper can write only
that approved descriptor; pathname replacement cannot redirect it. This isolates the file mutation, not the trusted
operator or every model session. Children receive no arbitrary shell, commit, push or merge capability. New-file
creation uses the approved absent path and pinned parent identity; an unexpected existing path is never overwritten.
New files remain untracked and their full contents appear in the review diff; the host does not stage them in Git.

Optional `checks` name exact command arrays such as `{ "id": "title-test", "command": ["node", "--test", "test/title.test.mjs"] }`.
Supported commands are `node --test` with literal relative test paths, `go test` / `go vet` with local package
paths (`./...`, `./pkg`, `./pkg/...`), and `["project", "make", "check"]` or other exact project argv. Go checks require
host-selected `ONIONSOUP_HOST_GO_ROOT` and self-contained modules: CGO, workspace discovery, toolchain downloads,
module downloads and host caches are disabled.

Project validation uses the host-selected `ONIONSOUP_PROJECT_TOOLS_FILE` profile of installed ELF executables.
It parses their library dependencies without executing them on the host, pins private copies of verified tool/library
bytes and runs the exact approved argv in a writable disposable copy of the verified source. Repository scripts,
Make recipes and mise tasks can run there without a command whitelist; downloads and host caches remain unavailable.
Synthetic Git fixture state and build output are discarded. Real repository Git metadata is never copied. The runtime
mounts neither the live worktree nor the host home or environment and retains network, memory, process, time and
output limits. Internal instruction symlinks retain exact target bytes; escapes, cycles, dangling links and metadata
links are rejected before execution. Approved edits still target regular named files only.

The child requests only an approved check ID; host code records bounded output, exit code and the exact artifact digest.
Go receipts record runtime version and Go executable SHA256 (not the whole toolchain). Project receipts record the
profile digest and each mounted runtime file's SHA256. These receipts are separate from model claims. Editing after a
check makes that receipt stale for acceptance; every configured check must have a current successful receipt. Failed
or incomplete checks remain visible without implying completion.
Before execution, a startup barrier lets the host pin the sandbox namespace-init process identity. Both normal
completion and forced shutdown require that pinned identity to disappear, alongside the existing bounded
process-group exit proof; a zombie leader alone is insufficient while its threads may still be exiting.
Unproved exit remains uncertain. This does not independently attest an empty cgroup.

A completed child enters `needs-review`. `review-write { id, childID }` verifies current workspace and terminal runtime
evidence and returns the exact host diff and review digest. The parent presents that diff, the original goal and
constraints; `accept-write { id, childID, digest }` asks for another native **Allow once**, bound to that exact review.
Both chat and inbox show the full diff, host check receipts and labeled bounded output, and distinguish child
conclusions as model claims. Fresh checks
before and after approval reject changed files, HEAD, scope or evidence. Acceptance releases the workspace claim and
allows normal job synthesis once all children are complete. Check success covers only the shown commands and artifact;
acceptance does not certify other tests or independent review, commit the edits or clean the worktree; a later write job needs a new clean baseline.

`revise-write { id, childID, digest, text }` sends a completed, unaccepted write child back for scoped
correction. Use its current `review-write` digest and feedback; the original human intake, task, approval,
paths, check commands, session and workspace claim stay unchanged. No new scope click or standing grant is
added. The host proves the exact idle final turn and unchanged artifact before queueing and again before
normal dispatch. Runtime reads remain outside mutation locks. Concurrent acceptance, pause, stale evidence,
foreign work, uncertain writes/checks, accepted children and already-started dependent work refuse the transition.
An already-paused job stays paused. Unstarted dependents keep waiting for the corrected child to be accepted;
independent accepted siblings are untouched.

Each revision archives the previous final evidence, artifact, review digest, feedback and check IDs. Existing
attempts, writes and check receipts remain immutable. Current evidence is cleared; even an unchanged result
needs new check receipts and a new human diff acceptance. Review output separates historical checks/revisions
from current checks. The default allows at most three revisions and retains the existing three-attempt budget
per configured check across all revisions; exhausted checks refuse a revision before another turn starts.
Exact repeated revision requests return the saved request without another dispatch; differing feedback against
that same old digest refuses. Restarts use the same session and durable dispatch receipts, without replaying
uncertain turns. This operation cannot expand scope, revise accepted work or release an uncertain reservation.

A prepared mutation with an unknown outcome remains blocked with its workspace reservation intact. Restart, cancel,
read-only abandonment and a fresh tool call cannot replay or clear it. This slice provides no uncertain-write recovery
or automatic replacement. The original transcript, intent and any receipt remain available for diagnosis.

An unaccepted queued, blocked or needs-review write child with **zero recorded mutations** can use the existing `recovery-preview` and
`abandon` actions after the host verifies absent or idle owned runtime state with no live tools or operation claim.
A separate native one-time recovery decision releases that reservation and revokes subsequent child tool use; it
does not accept the task or create a replacement. Unavailable, busy and foreign runtime state stays protected. Any
mutation record, including a resolved one, prevents this path; a late mutation invalidates the recovery digest.

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
are never budget evidence. The operator's fixed helpers share this probe with their existing budgets.

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


### Explicit attention assignment

Attention **Seen** records acknowledgment and leaves the human action queue while retaining owner history;
neither its note nor old acknowledged records start work.
**Assign repository fix** is a separate human action selecting a declared capable repository owner, repository,
title, outcome and acceptance criteria. The host validates that scope and persists the human author and source
in `state/attention/assignments` before creating one deterministic regular work request. The request is attributed
to the person through `operatorAssignment`; its from/to owner is the recipient, so it does not impersonate a manager.
The receiver still accepts or declines, and ordinary plan/review/publication gates apply. No consultation hire is
needed to submit this concrete request. The inbox displays its request status and linked work.

Repeated identical submissions adopt the request without reopening completed/denied work; changed input conflicts.
A daemon recovery pass handles only new explicit assignment sidecars, with current configuration checked before
new request creation and existing identities adopted after a crash. It attempts at most 20 pending assignments
per tick; each assignment stops after three routing failures or one invalid-scope failure. An explicit **Retry assignment** revalidates current scope and grants another bounded routing budget, adopting any existing request without restarting it. The original assignment author remains its provenance. There is no legacy backfill.
Assignment does not acknowledge, resolve or cancel the attention entry, and resolving attention does not cancel
its independently gated work request. This first version supports one immutable assignment per attention item;
reassignment/generations remain follow-ups. Stop existing work through its normal controls.


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

Revision blockers use a distinct informational inbox kind, so they cannot inherit attention assignment or Seen
controls. Feedback also repairs an idempotent `plan-feedback` notebook entry after delivery; journal failure does
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

### Read-only continuity rollout preview

`owners continuity-preview` reads bounded metadata directly and prints JSON. Unlike runtime readers that discover
journal entries or repair indices, this command takes no admission/record locks, creates no state directories,
refreshes no checkout, calls no model, and opens no request. It needs only `--state` and `--declarations` paths;
it does not load provider credentials or owner model configuration. It has no apply, activate or replay option.

The report includes configured/disabled/invalid friction policy and cutoff; the saved friction index's recent-100
window, excluded reports and investigation candidates; cached acknowledged attention without assignment; routing
states of handoffs, assignments and promotions; investigation states; and persisted admission/runner references.
Candidates still require runtime authority, cadence, source and busy-owner checks. Acknowledgment never makes an
item eligible for work. Routing status is distinct from the linked request's execution status. Admissions/runners
are conservative references whose liveness is unknown here; the preview does not certify deployment safety or
account for all live chats.

Reads are limited to 200 directory entries per category and 1 MiB per file. A larger file or truncated category is
reported, never interpreted as an empty queue. Attention coverage is its cached index and cutoff, with no transcript
or journal scan. Friction counts describe indexed captures, not every file on disk. Malformed metadata and missing
indices are named as unknown without echoing their contents; terminal symlink files, selected-root symlinks and named intermediate/queue-directory symlinks are refused before dependent reads. Files are opened nonblocking and must
be regular files, so a FIFO or device cannot stall preview. Queue scope distinguishes present, absent and unavailable;
an absent queue is not reported as a completed exhaustive scan, and the state root's availability is separate. Directories
must be the operator-selected state/configuration trees. The snapshot is non-atomic. Ancestor checks are best-effort lstat/open checks and do not eliminate concurrent path-replacement (TOCTOU) races; inspect trusted operator-selected state trees, not attacker-controlled directories. Its stable selection digest uses code-unit ordering independent of locale and
excludes sample time and identifies the displayed metadata selection only: it is neither consent nor a backfill
manifest. Repeat it before reviewing any future explicit selection.

Roll out in small observable steps:

1. Review the preview's scope, unknowns and active-work references. Use existing deployment admission and live-chat
   checks before any release; do not deploy or interrupt ongoing work on the strength of this report.
2. Keep friction policy absent while validating an isolated fixture with bounded live inference. Confirm that one
   report gives one investigation and that normal work still progresses. Provider fallback can use more than one
   underlying session, so inspect actual cost rather than equating dispatch count with spend.
3. With explicit operator approval, configure an activation-time cutoff and a conservative cadence for selected new
   reports. Review the first investigation before choosing **Request this fix**. Verify receiver acceptance, ordinary
   plan approval, and a concrete acceptance result; a routed request or merged PR alone is not proof friction ended.
4. Review historical acknowledged items and pre-cutoff wakes individually. This preview does not backfill them.
   No old note saying “fix this” becomes an assignment, and changing the cutoff is not a safe substitute for review.

Stop new investigation admission if repeated uncertain claims, invalid source/scope, missing evidence, unexpected
cost, duplicate work or slower existing work appears. Removing the optional friction policy stops future discovery;
it does not abort the current read-only hire or cancel already requested work. Handle existing requests with their
normal cancellation/recovery controls after reviewing active work. On rollback, retain additive sidecars and all
ordinary requests/work records. Older binaries may ignore the new views, but existing requests can still execute;
rolling back code is not cancellation. Never delete records to make a preview look clean.

Measure usefulness through concrete comparison tasks: fewer repeated human decisions for the same goal; fewer
facts Brian must relay between owners; fewer eligible obligations stalled across successive previews; and a progress
answer that names current evidence, uncertainty, blockers and next action. Compare duplicate request identities,
uncertain/blocked counts and observed inference cost alongside those user outcomes. The preview provides metadata
counts, not automatic measurements of conversational burden or verified business outcomes.


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
