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
Node server that starts its own opencode (which loads the plugin), imports the engine directly, relays opencode's
events to the browser, and keeps the person's settings (owner order, per-chat auto-accept); the opencode password
never reaches the browser. OpenChamber and its Owner's Desk panel came first and were retired for it.

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
  work happens. Desk changes become a verified, reviewed PR through `onionsoup_propose_changes`.

### Freelancers and workflows

Freelancer profiles (`freelancers/*.yaml`) are crafts with a rubric and allowed models. The `change` workflow
(`workflows/change.yaml`) is: plan (the owner answers the planner's questions) → the person approves or sends
it back with notes → implement in a worktree → host-run verification → review by a model outside the
implementer's family (checked from recorded providers) → revise or replan within limits → land as a commit on
`owners/<item>` → `publish` opens a draft PR (landed but unpublished work waits on the person in the Desk and in
the owner's status, which also reports recent outcomes). The `maintain-prs` duty keeps published PRs mergeable and green:
a conflict wakes the owner, which decides and briefs the implementer (the force-push waits for approval), and
failing CI on a new head commit wakes the owner once to decide fix (a work item at the plan gate), flaky, or person.
Owners hear how their work went: each daemon tick compares work items with what it last saw, journals changes the
owner should act on (landed, failed, rejected, PR merged or closed), and queues a notice that the plugin posts into
the chat the work was opened from, marked as coming from the runtime, so the owner decides the next step in front
of the person.
An owner with a `deploy` section and a `ship` grant ships its repository where it runs: fast-forward, verify in
the sandbox, restart through a delayed systemd unit that health-checks and rolls back.

### Notebooks and memory

Each owner has a notebook in a Git repository: `CHARTER`, `MAP`, `WISDOM`, `FAILURES`, `decisions`,
`open-questions`, and a journal. Everything the owner does is journaled; `distill` folds the journal into the
registers, and the owner is the curator. A notebook is knowledge, never authority.

Chat memory is deliberate. Tool calls that were not auto-allowed are journaled deterministically. After each
exchange a watcher from another model family extracts only the person's decisions, kept only if the quote is
verbatim; they land in the journal as candidates, and distill decides what enters the notebook. The person can
retract a note from the Desk or in chat. Every owner sees a generated roster of the other owners.

### Requests between owners

Owners ask each other questions (`onionsoup_ask`: answered from the other owner's notebook and fresh evidence,
split into observed, inferred and unknown) and open requests to each other:

| Request | From → to | After the receiving owner accepts |
| --- | --- | --- |
| `instance` | any → incus owner | person approves create (optionally the delete too), runtime creates, follow-up runs, delete |
| `publish-site` | site source → NAS owner | grant or person, then build · stage · swap · restart app · verify byte for byte · roll back on failure |
| `update-app` | NAS owner → itself | grant or person, then update through the API and follow the TrueNAS job to the end |

People only record decisions (approve, reject, revise-plan, resume, approve-create, approve-push, …); the
runtime acts on them, so decisions never race the daemon.

### Always on

`npm run owners -- daemon` (installed as `deploy/onionsoup-owners.service`) ticks every minute: it re-reads the
configuration, moves requests along, runs due duties, and advances work items. Deterministic
checks wake a model only when one is needed, and that model is the owner. Work a stopped runtime was actually
doing is marked interrupted and never replayed; a person resumes it.

### Safety

Every model-driven process and every verification runs in a memory-capped systemd scope (6 GB, no swap) inside
bubblewrap with a read-only root; only the implementer writes, and only its worktree. Bash allowlists are a
convenience, never the boundary: the implementer may run any command its repository needs, except committing,
pushing, `gh` and `sudo` (the sandbox can still read SSH keys and the gh login; landing is host code's job). A
Go-only allowlist left from the first owner made implementers on other stacks spend their whole hire probing. Owners never get CLIs that can mutate their domain (for example incus):
host code snapshots evidence read-only, and effects happen only in host code after approval.

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
  (OpenChamber's, the surface's) must not leak it into sandboxed servers.
- TrueNAS details that bit: `truenas_app_get` answers with a list, and an app is `STOPPED` between its old and
  new containers, so updates follow the upgrade job, not snapshots of the app's state.
