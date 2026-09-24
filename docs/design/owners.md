# Owners and freelancers

Living document: how onionsoup works today. Gaps are in [gaps.md](../gaps.md); how to create your own owners
and tools is in [extending.md](../extending.md).

## Overview

Onionsoup runs **owners**: persistent agents that each own one domain, such as a repository, a set of
virtualization hosts, a NAS or a wiki. An owner has a name and personality, a charter written by its person,
a notebook it curates, and authority bound in configuration. It watches its domain, answers questions about
it, and gets work done by hiring **freelancers**: planners, implementers and reviewers who are hired for one
piece of work, start from a brief, and keep nothing.

The runtime, not the prompt, enforces how work happens: plans wait for a person's approval, verification is
run by host code in a sandbox, reviews come from a different model family, and anything that creates,
deletes or destroys waits for a person unless the person granted standing approval in configuration.

Repository documents read as the project's record: decisions, rationale and consequences. Owner prompts and
implementer briefs keep conversational process history in PR descriptions, commit messages and notebooks;
reviewer briefs check for narration about who asked or which owners were consulted. Repository-specific
templates, conventions and review rubrics take precedence over this general writing guidance.

```
          events · schedules · deterministic checks · a person in chat
                                   │
                                   ▼
   ┌────────────────── owner (always on) ────────────────────┐
   │ persona · charter · notebook · authority · duties · desk │◄── ask / request ──► other owners
   └──────┬────────────────────────────────────▲─────────────┘
          │ brief                              │ deliverable
          ▼                                    │
     freelancers: planner → implementer → reviewer (another model family)
          │
          ▼
     gates: plan approval · create/delete · destructive actions (or a standing grant)
```

The person talks to owners in the **surface** (`packages/surface`) or the opencode TUI. Each owner is an opencode
agent whose chats run in its desk (or evidence folder). The surface is organized around owners: a rail of owners
with what waits and what runs, one inbox of every gate and chat permission with the decision in place, and per owner
its chats (drawn like OpenChamber's, whose styles it borrows under MIT), work, activity and notebook. It is a small
Node server that starts its own opencode (which loads the plugin from the person's real, host config — see the
threat model below), imports the engine directly, relays opencode's events to the browser, and keeps the
person's settings (owner order, per-chat auto-accept); the opencode password never reaches the browser. Inbox questions use the same form as chat: answers are collected
in question order, support multiple selections and permitted custom responses, and submit together. Work reviews
show each finding's issue and suggestion using the engine's shared work-item type.
OpenChamber and its Owner's Desk panel came first and were retired for it.

## Engine and configuration

Onionsoup is the engine. A person's owners are configuration that lives outside the repository:

| What | Where | Default |
| --- | --- | --- |
| Engine: runtime, CLI, opencode plugin, Owner's Desk | this repository | |
| Your owners: declarations, charters, freelancers, workflows, rubrics | `ONIONSOUP_CONFIG` | `~/.config/onionsoup` |
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
- **Duties**: what it does on its own, on a schedule (`every: 15m | 1d | 7d`). Kinds: `survey` (look and
  propose work, or raise attention items), `maintain-prs` (deterministic), `request-instance`, `app-updates`.
- **Conversation mode**: per-pattern `allow` / `ask` / `deny` rules for chats; `ask` means the person approves
  in the chat. Owners reach for their own tools first and can do anything else with approval.
- **Tools**: onionsoup tools, plus any MCP servers declared in `mcp:` (visible to that owner alone, with
  per-tool rules). The NAS owner gets truenas-mcp this way.
- **Stewards**: an owner with `manages:` creates, changes and retires owners within its scope through a tool that
  validates the whole configuration, refuses authority fields, asks the person, and commits to the config repo.
  The daemon re-reads the configuration every tick, so new owners start without a restart.
- **Grants**: standing approvals the person gives in configuration (`publish-site`, `update-app`, `merge`, `ship`),
  journaled as "approved by standing grant" whenever they are used.
- **Desk**: a worktree on a `desk/<id>` branch (or the evidence folder for non-repository owners) where chat
  work happens. Desk changes become a verified, reviewed PR through `onionsoup_propose_changes`. Publication is a ledger workflow: commit, push, PR creation, merge and site follow-up have durable checkpoints. Retrying a clean desk continues its unfinished publication, and its PR participates in maintenance. An active publication reports its progress; permanent failures name the cancellation needed before a new proposal. Journal failures remain visible without changing a completed publication back to failed.

### Freelancers and workflows

Freelancer profiles (`freelancers/*.yaml`) are crafts with a rubric and allowed models. The `change` workflow
(`workflows/change.yaml`) is: plan (the owner answers the planner's questions) → the person approves or sends
it back with notes → implement in a worktree → host-run verification → review by a model outside the
implementer's family (checked from recorded providers) → revise or replan within limits → land as a commit on
`owners/<item>` → `publish` opens a draft PR (landed but unpublished work waits on the person in the Desk and in
the owner's status, which also reports recent outcomes). The `maintain-prs` duty keeps published PRs mergeable and green:
a conflict wakes the owner, which decides and briefs the implementer (the force-push waits for approval), and
failing CI on a new head commit wakes the owner once to decide fix (a work item at the plan gate), flaky, or person.
A CI repair records the original PR and head, plans and implements from that head, and publication appends to that
PR after checking its head has not moved. Rebase maintenance preserves the whole PR, including earlier repairs,
and skips patch-equivalent commits already integrated on the base by a squash merge.
Desk publications use the same maintenance records. The chat that proposed a desk change is saved before
publication starts, so later merge and close notices return to that chat. Open PRs stay in the owner's Work
list and status text even when newer completed work fills its recent history. A desk PR merged immediately
under a grant produces a merge notice, including when publication and merging happen between daemon ticks.

Migration policy: desk PRs created before ledger-backed publication remain untracked. Their legacy
`desk-change-opened` journal entries are retained as history, but are not automatically imported: they do not
reliably record the repository, reviewed head, or originating chat needed for safe maintenance. Existing
ledger-backed desk publications remain tracked; missing origins are not guessed from unrelated chats.
An approved replan resets its worktree once; verification and review share a revision budget for each plan.
Owners hear how their work went: each daemon tick compares work items with what it last saw, journals changes the
owner should act on (landed, failed, rejected, PR merged or closed), and queues a notice that the plugin posts into
the chat the work was opened from, marked as coming from the runtime, so the owner decides the next step in front
of the person.
An owner with a `deploy` section and a `ship` grant ships its repository where it runs: fast-forward, verify in
the sandbox, restart through a delayed systemd unit that health-checks and rolls back. Both verification and
health-check failures reset to the previous revision, reinstall dependencies, and rebuild engine and browser
artifacts. Rollback failures are journaled as attention; the watchdog leaves services stopped if rebuilding fails.

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

Each chat turn also reads a bounded recent journal tail: questions and answers, work outcomes, CI triage,
attention, owner changes and person decisions. This supplies activity performed outside the conversation before
it reaches the notebook. Retractions in that window suppress earlier matching decision candidates; a later decision can reaffirm them. The owner's
`chatContext` policy bounds age, entries, characters and bytes read; malformed or incomplete lines are skipped.
Recent raw decisions supplement answering briefs even before distillation, and can overlap distilled memory so
concurrent decisions are not lost to a timestamp cutoff. They are context, never authority.

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
| `work` | any → repository owner with a workflow | receiver accepts or declines; accepted work enters its ordinary plan gate, and the request tracks the linked work through merge or failure |
| `instance` | any → incus owner | person approves create (optionally the delete too), runtime creates, follow-up runs, delete |
| `publish-site` | site source → NAS owner | grant or person, then build · stage · swap · restart app · verify byte for byte · roll back on failure |
| `update-app` | NAS owner → itself | grant or person, then upgrade the catalog or pull and redeploy images; follow the specific TrueNAS job to success |

App requests preserve image-update intent even when the catalog version is unchanged. Catalog upgrades use
truenas-mcp; image-only updates use the declared SSH connection to run `sudo -n midclt call app.pull_images`
with redeploy enabled (the SSH account needs permission for that command). Completion requires the tracked
job to succeed, the app to run at the target version, and image updates to clear. If a catalog upgrade leaves
image updates pending, a second tracked job pulls them; temporary polling failures retry within the deadline. Read-only recovery can confirm
a known successful job without starting another update. See the [TrueNAS API](https://api.truenas.com/v25.10/api_methods_app.pull_images.html).

People only record decisions (approve, reject, revise-plan, resume, approve-create, approve-push, …); the
runtime acts on them. Ledger updates use per-record kernel locks across daemon, CLI and surface processes.
Learning hires append their records to the latest item, preserving publication and person decisions made while
the hire runs.
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

`onionsoup_request_work` delegates to a declared repository owner. Acceptance creates one durable linked work item, with
all normal plan, verification, review and publication gates. Both owners hear completion, and declined or failed work raises
attention for both so the person can redirect it. Attention discovery imports only the previous seven days on its first run (the cutoff is persisted; older journal
history remains intact). It then indexes appended bytes, caches unchanged files, and skips malformed records without
breaking the inbox. Attention items can be acknowledged, resolved with an outcome, or reopened through `onionsoup_attention`. The inbox exposes acknowledge
and resolve controls and keeps acknowledged items visible until resolved.

### Always on

`npm run owners -- daemon` (installed as `deploy/onionsoup-owners.service`) ticks every minute: it re-reads the
configuration, moves requests along, runs due duties, advances work items, and raises work notices. Requests, duties and
work items run in the background beside the tick (one run per item, one item per owner, two of each at a time; requests reserve both participating owners and serialize shared resources), so
a long hire never holds up a 15-minute check or a waiting request. Deterministic
checks wake a model only when one is needed, and that model is the owner. Work a stopped runtime was actually
doing is marked interrupted and never replayed; every tick also checks external runner claims so a stopped
plugin or surface does not leave work stuck. A person resumes the recorded stage. Failed work can be retried
with fresh revision and replan budgets; exhausted review decisions resume implementation or planning directly. The item page and CLI (`resume`, `retry`, `cancel --reason`) expose these decisions;
queued work, unpublished local work and pending gates can be cancelled, while an active effect must finish first.
Cancelling a rebase suppresses automatic replacement for the same PR head.

### Safety

Every model-driven process and every verification runs in a memory-capped systemd scope (6 GB, no swap) inside
bubblewrap with a read-only root; only the implementer writes, and only its worktree. Bash allowlists are a
convenience, never the boundary: the implementer may run any command its repository needs, except committing,
pushing, `gh` and `sudo` (the sandbox can still read SSH keys and the gh login; landing is host code's job). A
Go-only allowlist left from the first owner made implementers on other stacks spend their whole hire probing. Owners never get CLIs that can mutate their domain (for example incus):
host code snapshots evidence read-only, and effects happen only in host code after approval.

### Threat model: what a sandboxed process can and cannot reach

`~/.config/opencode` is loaded as plugins by any host opencode process that reads the person's real config —
the surface's own unsandboxed opencode is the one currently running: anything written there runs on the host,
outside any sandbox, the first time that opencode restarts. Every sandboxed process (`runSandboxed`,
`spawnSandboxed`, so workspace verification, shipping, distro smoke, hosted-site builds and freelancer hires) gets
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
- Freelancer claims are not evidence: host code runs verification.
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
