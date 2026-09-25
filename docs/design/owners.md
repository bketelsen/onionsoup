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
with what waits and what runs, one inbox of every gate and chat permission with the decision in place, and per owner
its chats (drawn like OpenChamber's, whose styles it borrows under MIT), work, activity and notebook. The Friction
rail lists bounded incident reports and links them to their first reporting chat. It is a small
Node server that starts its own opencode (which loads the plugin from the person's real, host config — see the
threat model below), imports the engine directly, relays opencode's events to the browser, and keeps the
person's settings (owner order, per-chat auto-accept); the opencode password never reaches the browser. Inbox questions use the same form as chat: answers are collected
in question order, support multiple selections and permitted custom responses, and submit together. A work item's
page shows its plan (markdown), who approved it and a link to its work session; its activity rail lists the work
session and the subagent sessions it started (read from the surface's opencode) plus any hires, then the
publication stage, host verification and reviews, with each finding's issue and suggestion. Its decisions are
approve or send back a plan, retry, resume and cancel.
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
| Your owners: declarations, charters, freelancer models, model families | `ONIONSOUP_CONFIG` | `~/.config/onionsoup` |
| Runtime state: notebooks, ledger, requests, checkouts, desks, evidence, tools | `ONIONSOUP_HOME` | `~/.local/share/onionsoup` |

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
  work happens. Desk changes become a verified, reviewed PR through `onionsoup_propose_changes`; only blocker findings send them back. The review diffs the desk against where it meets its base branch (the merge base), so a desk that fell behind shows only its own change. `onionsoup_sync_desk` brings a desk up to date in host code: uncommitted work (intent-to-add entries included) is set aside under a unique stash, the desk moves to `origin/<base>`, and the work comes back; a conflict keeps the stash and names the files, and commits no remote holds are never moved (`desk_has_unpublished_commits`). Planning and execution sessions start from a synced desk. Review converges: each round with blockers is kept (`state/desk-reviews/`), and the next reviewer gets its findings and the diff since, checks those first, and blocks new points in already-reviewed text only for real errors. After `DESK_CHANGE_LIMITS.reviewRoundsBeforePerson` rounds (4) no reviewer is hired: the person reads the diff, and `owners desk-review-reset <owner> [repository]` starts afresh. An approval clears the history. Publication is a ledger workflow: commit, push, PR creation, merge and site follow-up have durable checkpoints. Retrying a clean desk continues its unfinished publication, and its PR participates in maintenance. An active publication reports its progress; permanent failures name the cancellation needed before a new proposal. Journal failures remain visible without changing a completed publication back to failed.

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
`Plan <id>: <title>`, where the person can watch and step in. The session may edit the desk without asking (a
session-level rule; the owner's other chats keep their rules). Its first message, marked as a runtime notice, is the
approved plan with any conditions of approval, and tells the owner to carry it out with
`subagent-driven-development` (an implementer subagent for each small task, its reviewer subagent after each), to
make and record the rulings the plan leaves open, and to end with `onionsoup_propose_changes` for the item. The item
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
`desk-publication` item as before. The item moves through `landing` to `landed`; completion of delegated work still
means its PR merged.

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
pending wake intent. The surface lists these reports and links to the first reporting chat. Capture does not yet
consume the intent, notify Leto, provide a workaround or draft/publish a GitHub issue.

### Requests between owners

Owners ask each other questions (`onionsoup_ask`: answered from the other owner's notebook and fresh evidence,
split into observed, inferred and unknown). Each answer queues a durable runtime notice for the answering
owner's latest person chat, discovered from existing nonchild sessions and persona user messages. The plugin
waits for that chat to be idle, then posts with `noReply`; the decision watcher skips runtime notices. No person
chat means the notice stays pending. A pinned destination and stable message ID reconcile a post accepted before
a crash; transport failures retain the queue entry. Full exchanges remain in `notices/exchanges` under the state
directory, and shortened notices cite their record ID. Owners also open requests to each other:

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

### Always on

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
