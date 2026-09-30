# Owners

Living document: how onionsoup works today. Gaps are in [gaps.md](../gaps.md); how to create your own owners
and tools is in [extending.md](../extending.md).

## Overview

Onionsoup runs **owners**: persistent agents that each own one domain, such as a repository, a set of
virtualization hosts, a NAS or a wiki. An owner has a name and personality, a charter written by its person,
a notebook it curates, and authority bound in configuration. It watches its domain, answers questions about
it, and runs its own work: it plans with the person in chat following **skills** (a process adapted from
obra/superpowers), and carries out an approved plan in its own session, handing small tasks to an
**implementer subagent** and checking each with a **reviewer subagent** from another model family.

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
     work session: implementer subagent → reviewer subagent (another family), task by task
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
  Kinds: `survey` (look, update the notebook, and raise what it found as attention items: work the owner can plan
  with the person in chat, never work items), `maintain-prs` (deterministic), `request-instance`, `app-updates`.
- **Conversation mode**: per-pattern `allow` / `ask` / `deny` rules for chats; `ask` means the person approves
  in the chat. Owners reach for their own tools first and can do anything else with approval.
- **Tools**: onionsoup tools, plus any MCP servers declared in `mcp:` (visible to that owner alone, with
  per-tool rules). The NAS owner gets truenas-mcp this way.
- **Stewards**: an owner with `manages:` creates, changes and retires owners within its scope through a tool that
  validates the whole configuration, refuses authority fields, asks the person, and commits to the config repo.
  The daemon re-reads the configuration every tick, so new owners start without a restart.
- **Grants**: standing approvals the person gives in configuration (`publish-site`, `update-app`, `merge`, `ship`,
  `approve-plans`), journaled as "approved by standing grant" whenever they are used.
- **Reporting line**: `reportsTo` names an owner's manager. The roster every owner reads is drawn as that tree, and
  a manager plans cross-repository work through its reports (see [Org chart and initiatives](#org-chart-and-initiatives)).
- **Desk**: a worktree on a `desk/<id>` branch (or the evidence folder for non-repository owners) where chat
  work happens. Desk changes become a verified, reviewed PR through `onionsoup_propose_changes`; only blocker findings send them back. The review diffs the desk against where it meets its base branch (the merge base), so a desk that fell behind shows only its own change. `onionsoup_sync_desk` (with a plan's `item`, that plan's worktree) brings a desk up to date in host code: uncommitted work (intent-to-add entries included) is set aside under a unique stash, the desk moves to `origin/<base>`, and the work comes back; a conflict keeps the stash and names the files, and commits no remote holds are never moved (`desk_has_unpublished_commits`). A desk put on an open PR with `onionsoup_checkout_pr` is not synced (`desk_on_pull_request`): moving it would drop the PR's commits, and the PR's conflicts with its base are the `maintain-prs` rebase's to resolve, which the refusal names when one is open. Planning sessions start from a synced desk; an approved plan works in its own worktree, not the desk (see Execution sessions). Required desk reviews receive sanitized host command exit statuses tied to the exact source tree and observation time, plus the original approved task acceptance criteria. No configured commands is explicitly reported as no checks; sandbox evidence never implies live deployment. Source changes during verification or review invalidate that evidence before publication. Approved-plan publication retains its original goal instead of replacing it with the implementation summary. Review converges: each round with blockers is kept (`state/desk-reviews/`), and the next reviewer gets its findings and the diff since, checks those first, and blocks new points in already-reviewed text only for real errors. After `DESK_CHANGE_LIMITS.reviewRoundsBeforePerson` rounds (6) no reviewer is hired: the person reads the diff, and `owners desk-review-reset <owner> [repository] [--item <plan>]` starts afresh (a plan's worktree keeps its own rounds). An approval clears the history. Publication is a ledger workflow: commit, push, PR creation, merge and site follow-up have durable checkpoints. Retrying a clean desk continues its unfinished publication, and its PR participates in maintenance. An active publication reports its progress; permanent failures name the cancellation needed before a new proposal. Journal failures remain visible without changing a completed publication back to failed.

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

An owner's task permission lets it start only its own two subagents, and subagents are denied every `onionsoup_*`
tool: effects and records stay with the owner and host code. A subagent's edits, and commands outside the owner's
allowed rules, are journaled to the owner whose session started it (kind `subagent-action`). A subagent whose model
the configuration cannot supply is left out with `onionsoup_subagent_unavailable` in the log instead of breaking
chats. Freelancer declarations (`freelancers/*.yaml`) now only name models: `implementation` (the implementer
subagent, and conflict resolution hires in rebases) and `review` (each owner's reviewer subagent, the required host
review of desk changes, and the review of conflict resolutions). A `craft: planning` file, a `workflows/` directory
and `workflow:` lines on owners are left over from the retired freelancer pipeline and ignored.

Host hires that return a typed deliverable (reviews, owner answers and decisions, distill) ask opencode for
structured output, which forces a tool call. A model that refuses forced tool choice (Copilot's `claude-opus-5.5`,
anomalyco/opencode#46735) is retried at once in a new session in text mode: the brief ends with the JSON Schema, the
reply's JSON is parsed and validated against the same schema, and the model starts in text mode for the rest of the
process. Any model can therefore serve as an owner, implementer or reviewer.

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
without asking (a session-level rule; the owner's other chats keep their rules). Its first message, marked as a runtime notice, is the
approved plan with any conditions of approval, and tells the owner to carry it out with
`subagent-driven-development` (an implementer subagent for each small task, its reviewer subagent after each), to
make and record the rulings the plan leaves open, and to end with `onionsoup_propose_changes` for the item. The
reviewer subagent grades on the same scale as the required review (`REVIEW_SEVERITIES`), so blockers surface per task;
there is no whole-change review of the owner's own, since the required review at proposal is one and a send-back
commits nothing. After `DESK_CHANGE_LIMITS.reviewRoundsBeforePerson` send-backs, the person reads the diff. The item
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
still propose from the desk. The item moves through `landing` to `landed`; completion of delegated work still means
its PR merged. The worktree outlives the merge: the plan's session often keeps working there after its PR merges
(a rollout run from the worktree), so neither the finish step, the publication refresh nor a cancellation removes it,
and the item's session keeps its real directory. A plan is finished once it is `landed` with its PR merged or closed,
or `cancelled`. The plugin's cleanup pass (`removeIdlePlanWorktrees` in `plan-worktrees.ts`, on the same
`PLUGIN_LIMITS.noticeMs` pass that opens sessions) looks only at finished items that still have a `planWorktree`,
asks opencode for the session's status and last update, and removes the worktree and its branch once the session is
not busy (or retrying) and has not changed for `PLAN_WORKTREE_LIMITS.idleBeforeRemovalHours` (24); an item without
a session, or whose session is gone, counts from the item's own last update. A worktree with uncommitted changes, or
commits no remote holds, is never removed: it stays, the item records why (`planWorktreeKept`), and the person's
attention is raised once per reason, not every pass. Each removal is journaled (`plan-worktree-removed`).

**Repairs on the desk.** The `maintain-prs` duty keeps published PRs mergeable and green. Failing CI on a new head
commit hires the owner once for that commit to decide fix, flaky or person; no work item is opened. `fix` wakes the
owner with a notice in the session or chat the PR came from. `onionsoup_checkout_pr { item }` puts a clean desk on
the PR's head, and `onionsoup_propose_changes` with that item reviews the fix against the PR head and pushes it with
`--force-with-lease` onto the same PR, refusing if the head moved; no new PR is opened.

**Rebase maintenance.** A conflicting PR gets a `rebase` work item. A clean replay that passes verification needs no
model. A conflict hires the owner (sandboxed, with its notebook) to decide whether and how it is resolved; it
briefs the implementer hired next (the `implementation` freelancer), a reviewer from another family checks the
resolution, and the force-push waits for the person (`approve-push`). Rebase maintenance preserves the whole PR, including earlier repairs, and skips
patch-equivalent commits already integrated on the base by a squash merge. Desk publications use the same
maintenance records. The chat that proposed a desk change is saved before publication starts, so later merge and
close notices return to that chat. Open PRs stay in the owner's Work list and status text even when newer completed
work fills its recent history. A desk PR merged immediately under a grant produces a merge notice, including when
publication and merging happen between daemon ticks.

Migration policy: desk PRs created before ledger-backed publication remain untracked. Their legacy
`desk-change-opened` journal entries are retained as history, but are not automatically imported: they do not
reliably record the repository, reviewed head, or originating chat needed for safe maintenance. Existing
ledger-backed desk publications remain tracked; missing origins are not guessed from unrelated chats. Open work of
the retired `change` workflow fails once at daemon start with `pipeline_removed` (`retirePipelineItems`); its record
stays, and the owner can plan it again.

**Notices.** Owners hear how their work went: each daemon tick compares work items with what it last saw, journals
changes the owner should act on (landed, failed, PR merged or closed), and queues a notice that the plugin posts,
marked as coming from the runtime, into the item's work session first, else the chat the work came from. CI fix
requests and send-backs of plans reach the owner the same way. The owner decides the next step in front of the
person.

**Shipping.** An owner with a `deploy` section and a `ship` grant ships its repository where it runs. Before touching
the deploy checkout, ship checks the full ledger and refuses with the IDs, titles and statuses of any items with
active runners, including other owners' work. Once clear, it fast-forwards, verifies in the sandbox, and restarts
only the owner's configured deploy services through a delayed systemd unit that health-checks and rolls back. This
up-front check does not prevent new work from starting during verification.

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
retract a note from the Desk or in chat. Every owner sees a generated roster of the other owners.

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

The worker reads the existing clean checkout, records its commit, and explicitly labels remote freshness unknown;
it never fetches, resets or gathers infrastructure snapshots. A sandboxed owner hire with shell access denied returns observed/inferred/unknown
facts and either a bounded proposed fix in that repository, missing evidence, or no action. A versioned sidecar in
`state/friction/investigations/<id>.json` holds the claim, result, session and cost. Unreadable wake/sidecar candidates are skipped with a diagnostic naming the report, so another valid report can proceed.
The surface shows unavailable investigation status on a corrupt sidecar while preserving other reports. Original reports and pending wake
files stay compatible; the sidecar is the processing status. Repeated discoveries adopt the saved result. A crashed
claim becomes `blocked: friction_triage_delivery_uncertain`; inference failures stop without automatic paid retries.
The cadence timestamp is durable before dispatch; a crash there may delay dispatch by one interval. The underlying
hire has the existing timeout and structured-output fallback/resend behavior; this is a dispatch bound, not a dollar cap.

The Friction list/detail shows processing status and the proposed fix with its evidence; no new inbox item is created.
`owners friction-investigation <id>` reads the result. `owners friction-triage <id>` explicitly investigates one
selected eligible wake under the CLI runtime lock (it cannot run beside the daemon). This operator command bypasses
the daemon cadence but cannot repeat a saved/uncertain investigation. Neither investigation path sends messages, opens requests, publishes issues, edits code, or claims a fix completed.

The person's **Request this fix** action promotes the displayed proposal, bound to its digest, into an ordinary
human-attributed work request. `owners friction-promote <id> <digest>` does the same; the read command above supplies
the digest. A durable intent in `state/friction/promotions` stores who requested it and the exact proposal before
routing. The source friction ID determines one request identity. Repeated clicks, process restarts and lost replies
adopt that request's current status; cancelled, declined and completed work never reopens. Receiver acceptance,
plan approval, verification and effect gates remain intact. The Friction view links the responsible owner and work,
and shows request status separately from verification that the original friction is fixed.

Routing retries only saved human intents, at most three attempts per authorization (up to 20 pending intents per
tick), then stops with a visible reason. **Retry request routing**, or
`owners friction-promotion-retry <id> <digest>`, explicitly resets an exhausted routing budget after rechecking the
captured recipient's current repository scope. It never resets an existing request's execution or terminal status.
No investigation is automatically promoted, and no historical wakes or attention acknowledgments are backfilled. Disabling policy stops new dispatch; it does not cancel an already running read-only hire. No policy is installed
by an upgrade; choosing an activation-time cutoff preserves legacy pending wakes for separate approved backfill.

### Requests between owners

Owners ask each other questions (`onionsoup_ask`: answered from the other owner's notebook and fresh evidence,
split into observed, inferred and unknown). Each answer queues a durable runtime notice for the answering
owner's latest person chat, discovered from existing nonchild sessions and persona user messages. The plugin
waits for that chat to be idle, then posts with `noReply`; the decision watcher skips runtime notices. No person
chat means the notice stays pending. A pinned destination and stable message ID reconcile a post accepted before
a crash; transport failures retain the queue entry. Full exchanges remain in `notices/exchanges` under the state
directory, and shortened notices cite their record ID. Owners also open requests to each other.

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
The asked/answered journal entries and original exchange notice are best effort: a crash or write failure can
omit them, and replay does not recreate them. The full answer/origin stay in the handoff record; the daemon repairs
the separately tracked request-opened journal. Exchange notification and journals are informational, not the
authoritative handoff state. Rollback leaves the
new sidecars unread by older binaries; regular requests retain their existing schema and execution semantics.

The requester now receives a current cross-owner progress summary in chat context and `onionsoup_status`.
Visibility includes request participants and the receiving owner's direct manager, matching report-work visibility;
it does not expose unrelated owners' work. Each row names the goal, accountable receiver, decision, linked work,
blocker, recorded PR evidence and next step. It gives the record-read time and last-change time, labels records
older than 24 hours as stale, and treats absent/mismatched linked work as unknown. Reading status does not probe
live services, and repository merge never claims deployment. Recently finished requests stay visible for seven days.
Injected cross-owner progress summaries (not all other chat-context sections) prioritize active requests and are bounded to 12 records and 12,000 characters. Omitted records
and abbreviated blocker details are explicitly labeled; `onionsoup_status offset=<next>` pages through them,
and `onionsoup_status request=<id>` reads full details under the same visibility check.

New direct work requests and actionable asks retain the exact requester chat origin. The admitted daemon queues
significant request/work/PR changes there as **informational `noReply` notices**, never model wakes, approvals or
new work. Timestamp-only refreshes are suppressed. A persisted per-request outbox in
`state/notices/request-progress` holds each notice before enqueueing; a stable ID lets the existing exchange
transport reconcile posts accepted before a crash. Transition IDs preserve per-request delivery order. At most
20 new transitions are queued per tick. On first observation an atomic `baseline.json` records the complete
preexisting request snapshot before any notices are queued. That snapshot stays silent across restarts; requests
created after it and subsequent significant changes can notify. A crash during baseline creation cannot create
partial historical delivery. Existing pending outbox intents are flushed even if the owner has retired, so the
exchange transport can retain an explicit undeliverable record. Origin-less legacy requests remain visible through status but receive
no guessed-chat delivery or backfill. Missing/unavailable origin chats retain pending notices; retiring an owner
uses the exchange transport's undeliverable record. The status summary remains useful even when delivery fails.

These are snapshots of observed transitions, not an exhaustive event log: a transition occurring and disappearing
between ticks can be missed. Queued snapshots retain observation times and may be old by delivery; read status
for current records. Reads across request and ledger files are not transactional. Informational notices do not
promise that a coordinator will automatically resume reasoning; they give it durable context for its next turn.

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
attention for both so the person can redirect it. Attention discovery imports only the previous seven days on its first run (the cutoff is persisted; older journal
history remains intact). It then indexes appended bytes, caches unchanged files, and skips malformed records without
breaking the inbox. Attention items can be acknowledged, resolved with an outcome, or reopened through `onionsoup_attention`. The inbox exposes acknowledge
and resolve controls and keeps acknowledged items visible until resolved.

### Org chart and initiatives

The org chart is configuration: `reportsTo: <owner>` on a declaration. Loading refuses unknown managers
(`org_chart_unknown_manager`), self-reports (`org_chart_self`) and cycles (`org_chart_cycle`). A steward may put owners
in its scope under itself or take them back out, but never sets, changes or clears a line to anyone else. Each
owner's prompt says who its manager and direct reports are; `managerOf`, `directReports` and `isDirectReport` in
`declarations.ts` are the only readers of the field.

Work a manager requests from a direct report is accepted automatically (no hire; only the report is reserved in the
request pool) and still goes through the report's ordinary plan approval, verification, review and publication gates. A
peer's request is still decided by the receiver.

An **initiative** (`state/initiatives/<id>.json`, `org-work.ts`) is a manager's cross-repository change: assignments
to its direct reports, each a proposal with `after` dependencies. The manager drafts, updates and submits it in chat
with `onionsoup_initiative` (shown only to owners with reports); the draft records that chat. Submission checks every
assignment: the assignee is a direct report that can change its repository (`canChange`), owns the named repository, and has a `maintain-prs` duty
(completion means merged, so a report that cannot observe merges is refused); dependencies exist and do not cycle;
the manager has fewer than `INITIATIVE_LIMITS.maxOpenPerManager` open initiatives. The person approves, sends back
or cancels it once, in the surface inbox or with `owners approve-initiative | revise-initiative | cancel-initiative`.
Any edit after submission is a new revision that stops dispatch until the person approves it again.

Each daemon tick runs `superviseInitiatives` after requests. It is deterministic and acts only on an approved
initiative whose approval names its current revision: an assignment whose dependencies have all merged is dispatched
as a work request carrying its assignment reference (a request already carrying that reference is linked instead of
repeated), and the initiative completes when every assignment merged or fails when one failed. An assignment stores
only its request id; its state (requested, working, plan waiting, waiting on the person or a merge, merged, failed)
is derived from the request and work item. Completion still means merged, so a chain waits on the person wherever a
PR waits to be merged.

The manager hears how assigned work goes: the notice pass journals each change to her too and queues a manager
notice into the initiative's chat (`WorkItem.origin` stays the item owner's chat), which wakes her there. Approval,
send-back, cancellation, completion and failure of the initiative reach the same chat.

**Plan approval under grant.** A report may give its manager `approve-plans` (a grant on the report's declaration,
`to` its manager, target a repository or `*`; loading refuses one to anyone else with `grant_not_to_manager`). For
each new plan (by digest) waiting in a supervised initiative, the daemon wakes the manager once, with a notice in
the initiative's chat; no model is hired for it. She reads the plan and approves it or sends it back with a note
through `onionsoup_steer`. Approve records the plan approval as `owner:<manager> (standing grant approve-plans in
<report>)`, journals `grant-used` to both notebooks, and the plugin opens the report's work session; a send-back
moves the plan back to `planning` and wakes the report where it planned. After `SUPERVISION_LIMITS.revisionsPerItem`
send-backs the plan is left for the person and raises the manager's attention. Without the grant the plan waits for
the person as always, and the inbox says when the manager reviews under a grant. A person who sends a delegated plan
back from the inbox does the same as a manager's send-back.

**Steering and pushback.** A manager reads all her direct reports' work with `onionsoup_status`, assigned or taken on
directly (one-off requests, their own work), and it lists her initiatives. She acts only on work her initiatives
assigned, with `onionsoup_steer` (approve a plan under the grant, send it back, cancel the work, or leave the report
a note); reading is oversight, steering is authority. A report pushes back with `onionsoup_raise` (objection, question or blocked): the
escalation is stored on the initiative, journaled to both, raised as the manager's attention, and wakes her. While it
is open she cannot approve that assignment's plans; she resolves it with `onionsoup_initiative resolve-escalation`.

The surface shows the tree under **Org**, each initiative's assignments by dependency step with their state, work,
PRs, escalations and plan reviews, and initiatives awaiting approval in the inbox.

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
These are accepted best-effort limits (see [gaps](../gaps.md)). Bootstrap is manual; arm
and enable the timer only after verifying both installed services and the plugin use the
release pointer.

`npm run owners -- daemon` (installed as `deploy/onionsoup-owners.service`) ticks every minute: it re-reads the
configuration, reads the state of every open PR (`refreshPublications`, so merges and closes are seen within a minute
and everything after reacts on the same tick), moves requests along, supervises initiatives, runs due duties,
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
rules on purpose. It owns nothing, keeps no owner notebook, runs no duties, and is woken by the runtime only for the
memory nudge below; owners cannot
reach it (it is in no roster, and `onionsoup_ask`, `onionsoup_request_work` and friends resolve only owners). Its id
`operator` and its name are reserved: no owner may take either (`operator_reserved`).

Its permissions allow nearly everything: any bash, edits, the web, any directory, subagents and questions. Only
`OPERATOR_ASK_BASH` asks, plus the person's own `ask:` patterns: recursive deletes, force pushes, hard resets and
`git clean`, deleting incus instances, destroying ZFS datasets and pools, `mkfs`, `dd`, `kubectl delete`, and the
CLI's person gates (`owners ... approve*`, `owners ... ship*`), so it does not answer an owner's plan or ship for the
person unasked. It gets no `onionsoup_*` owner tools (they are denied, and refuse any agent that is not an owner)
except `onionsoup_wiki`, with which it only reads the [wiki](#wiki), so it cannot submit, approve or ship through them, and the plan-approval, ship and owner-change prompts of owners'
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
environment, and server output quoted in a hire error is redacted. A provider that cannot force a tool call
(`structuredOutput: false`) starts its hires in text mode. Built-in provider ids are refused (`provider_reserved`),
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

Attention **Seen** only records acknowledgment; neither its note nor old acknowledged records start work.
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
indices are named as unknown without echoing their contents; terminal symlink files and named queue-directory symlinks are not followed. Files are opened nonblocking and must
be regular files, so a FIFO or device cannot stall preview. Queue scope distinguishes present, absent and unavailable;
an absent queue is not reported as a completed exhaustive scan, and the state root's availability is separate. Directories
must be the operator-selected state/configuration trees. The snapshot is non-atomic. Its stable selection digest uses code-unit ordering independent of locale and
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
