# Owners and freelancers

Living document. Status: **proposed**. This is the design for the rewrite on
the `owners` branch. Nothing here is built yet. It replaces the direction in
[composable agents](composable-agents.md) and [the web operator surface](web.md)
once it lands.

## Overview

The original thesis was single-purpose agents that own a thing, composed into
workflows. What got built was a catalog of single-shot agents: each one ran a
task, returned one result and forgot everything. Those agents were functions,
not owners. The job host and recipes were good plumbing for composing
functions, but nothing in them owned anything.

This design puts ownership back at the center. There are two kinds of agent:

- **Owners** are persistent project managers for one domain, such as a
  repository or the homelab's virtualization. An owner knows its domain,
  holds its authority, keeps a notebook, watches for events and pushes work
  out.
- **Freelancers** are hired for one piece of work. Each has a craft, such as
  planning, implementation, review or research. A freelancer starts with a
  brief, delivers an artifact and keeps nothing.

Workflows are contracts between them. The runtime enforces their stages and
gates; prompts only describe them.

```
          events (GitHub, schedules, probes, people)
                          │
                          ▼
  ┌───────────── owner (PM, always on) ─────────────┐
  │ charter · notebook · authority · inbox · duties │◄──── messages ────► other owners
  └───────┬──────────────────────────────▲──────────┘
          │ brief                        │ deliverable
          ▼                              │
   freelancers: planner → implementer → reviewer (different model family)
          │
          ▼
   human gates: plan approval · create/delete · destructive actions
```

## Decisions so far

| Question | Decision |
| --- | --- |
| Summoned or always on? | Always on. Owners react to events and run standing duties. |
| Who does the work? | Owners are project managers. They scope work and hire freelancers. They do not implement. |
| Where does knowledge live? | In onionsoup's notebooks, one per owner. Euclid's register-plus-journal model is the reference. |
| Do owners talk to each other? | Yes, directly. Requests that create or delete resources need human approval. |
| Where is the human? | Plan approval and destructive actions. |

## Design

### Owner

An owner is declared once and keeps one identity across sessions and model
changes.

```yaml
# owners/onionsoup-repo.yaml
id: onionsoup-repo
domain: { kind: github-repository, name: bketelsen/onionsoup }
charter: notebooks/onionsoup-repo/CHARTER.md
authority:
  checkout: ~/projects/onionsoup
  github: [issues.read, issues.comment, pulls.draft]
duties:
  - { on: issue.opened, do: triage }
  - { every: 1d, do: ci-health }
model: { provider: copilot, model: claude-sonnet-5 }
budget: { wakes_per_hour: 6, cost_per_day_usd: 2 }
```

An owner has:

- **A charter.** A human-written statement of the domain, its goals and its
  boundaries. Only a person edits it.
- **A notebook.** Knowledge the owner writes and curates (see below).
- **Authority.** The credentials and tools for its domain, bound in
  configuration. Nobody else holds them. Anyone who wants something done in
  the domain asks the owner.
- **Duties.** Events and schedules it responds to.
- **An inbox.** Messages from people, other owners and the runtime.

An owner handles its domain like a project manager:

1. It triages events and questions, using its notebook.
2. It turns worthwhile work into a work item with a brief.
3. It hires freelancers through a workflow and answers their questions.
4. It accepts or rejects what they deliver.
5. It lands accepted work. The owner holds the push and PR authority, so
   freelancers never do.
6. It writes what it learned into its notebook.

An owner can read and investigate in its domain directly, since that is how it
answers questions and writes briefs. Changes go through freelancers. Where
exactly that line sits is open question 1.

### Freelancer

A freelancer profile is a craft, not an identity:

```yaml
# freelancers/implementer.yaml
craft: implementation
rubric: rubrics/implementation.md
families: [anthropic, openai]      # models this craft may be hired on
workspace: worktree                # what the runtime provisions per hire
tools: [read, edit, shell.sandboxed, test]
```

Built-in crafts to start with are planner, implementer, reviewer and
researcher. The planner has the rubric for what a good plan contains; the
reviewer has the rubric for review.

Each hire gets:

- a brief (below);
- a fresh workspace, such as a worktree or sandbox, and nothing outside it;
- a model the workflow chose within the craft's allowed families.

It returns a deliverable. It has no memory, no credentials outside its
workspace and no way to message other owners. If it needs something, it asks
the owner that hired it.

The mix of owners as managers and freelancers as workers is deliberate. One
knowledgeable, accountable agent per domain keeps context and authority in one
place. Cheap, disposable workers keep each piece of work small, parallel and
free to use any model family. That is also what makes cross-family review
easy.

### Briefs and deliverables

A **brief** is the only way context reaches a freelancer. It has:

- the goal;
- context, as notebook excerpts cited by register and section;
- constraints and acceptance criteria;
- the workspace;
- a budget.

Freelancers never share a conversation with the owner or with each other.

A **deliverable** is a typed artifact with its evidence: a plan, a diff and its
test results, a review verdict or a research report. Deliverables are
validated at the edge like any other model output.

### Notebook

Each owner has a notebook that onionsoup stores and versions. The layout
borrows from Captain Code's Euclid brains:

```
notebooks/<owner>/
  CHARTER.md          human-only: domain, goals, boundaries
  MAP.md              the domain's layout: repository structure, host and VM inventory
  WISDOM.md           conventions and lessons that hold
  FAILURES.md         incidents and what caused them
  decisions.md        decisions with dates and reasons
  open-questions.md
  journal/<date>.jsonl  one line per wake, hire, deliverable and message
```

These rules apply:

- The owner appends to the journal as it works and writes notes while the
  context is fresh.
- A periodic distill step folds the journal into the registers. It may only
  append or replace sections, never rewrite a whole register.
- Every notebook change is a Git commit, so a person can read, revert or edit
  what the owner believes.
- **A notebook is knowledge, never authority.** Nothing in a notebook grants a
  tool, a credential or permission for an effect.
- Briefs cite notebook sections. A freelancer's rejected assumptions and a
  reviewer's findings flow back into the journal.

The first slice has to answer whether an owner's notebook noticeably improves
its second and third pieces of work over the first. If it doesn't, ownership is
just packaging.

### Workflows

A workflow is a declared state machine. Each stage names who does it, what it
takes in, the artifact type it must produce, and any gate:

```yaml
# workflows/change.yaml
stages:
  plan:
    by: { craft: planning }
    consult: $owner
    produces: plan
    gate: human
  implement:
    by: { craft: implementation }
    input: plan
    produces: change
  review:
    by: { craft: review, family: not($implement.family) }
    input: [plan, change]
    produces: verdict
    on:
      revise: { to: implement, max: 2 }
      replan: { to: plan, max: 1 }
  land:
    by: $owner
    input: [change, verdict]
    produces: draft-pr
```

The runtime enforces these, not the prompt:

- Stage order, and each stage's required input artifacts.
- Artifact schemas: a stage fails with a specific reason if its artifact does
  not validate.
- Gates. A gated stage's output is not usable until a person approves it.
- Model families. The reviewer's family is checked against the implementer's
  recorded provider and model before the review is hired.
- Loop limits and budgets.

**Model families** are a configured table from provider and model to family
(`anthropic`, `openai`, `google`, `xai`, `open-weights`). The change workflow
requires at least two families to be available. Copilot alone serves Claude
and GPT models.

The **change workflow** is the first one: plan, approve, implement, review in
a different family, land. Landing opens a draft PR. Plan approval covers it.
Merging stays with a person.

### Owners talking to each other

Owners exchange typed messages through their inboxes:

| Message | Meaning | Reply |
| --- | --- | --- |
| `ask` | A question about the recipient's domain | `answer`, citing notebook or observations |
| `request.work` | Do something in your domain | `accept`, `decline` with a reason, or `counter` |
| `request.resource` | Create or delete something in your domain | Same, and a human approval before anything happens |

For example, the repository owner needs a throwaway VM for an integration test:

1. The repository owner sends `request.resource` to the virtualization owner.
2. The virtualization owner checks capacity in its notebook and live state,
   then accepts with a proposed VM spec.
3. The create goes to a person for approval.
4. On approval, the virtualization owner hires a freelancer to provision the
   VM, verifies it, and answers with a handle.
5. When the test finishes, the delete also needs approval (see open question 5
   about leases).

Every thread is recorded. The runtime bounds how deep a delegation chain can
go, how many messages a thread can have, and prevents request cycles.

### Always-on runtime

The runtime is a long-running service. It is not a set of forever-running
model loops. Owners are woken:

- **Event sources:** GitHub (polling first, webhooks later), schedules, homelab
  probes, inbox messages and people.
- **A wake** is a short owner turn. It starts from the charter, a notebook
  orientation, the event and pending inbox items. The owner ends it by
  deciding: ignore, note, answer, open a work item, hire, or message another
  owner.
- **Budgets:** per-owner wake rates, daily cost caps and quiet hours. All
  limits are configuration.

The ledger records every wake, work item, brief, hire, deliverable, message and
approval with its provider, model and outcome. Work interrupted by a restart
is marked interrupted and never silently replayed.

### Human in the loop

Every effect has a class, and the class decides the gate:

| Effect class | Examples | Gate |
| --- | --- | --- |
| Observe | Read issues, list VMs, run read-only probes | None |
| Workspace change | Edits and tests inside a freelancer's worktree or sandbox | None |
| Publish | Open a draft PR, comment on an issue | Covered by plan approval |
| Create or delete | New VM, new branch on a shared system, delete a snapshot | Human approval, per request |
| Destructive or production mutation | Migrate or stop a VM, change cluster state, force-push | Human approval, per action |
| Plan | A plan from the change workflow | Human approval |

Approvals collect in one inbox that shows the artifact, the diff or the exact
action, who asked and why. Where that inbox lives is open question 6.

### Authority

- Credentials and tools bind to owners in configuration. A model or a chat
  message picks among configured things by ID and never chooses authority.
- Freelancers get workspace-scoped capabilities issued per hire, such as a
  worktree with no push rights or a sandbox with no network. The owner does
  anything that leaves the workspace.
- Effects are recorded with the approval that allowed them.

## What carries over from onionsoup

**Kept as ideas:**

- Authority comes from configuration, never from chat or model output.
- Effects are explicit and gated.
- Every step is a record you can open, with its provider and model.
- Answers cite evidence.
- Interrupted work is marked interrupted, not replayed.
- The code rules in `AGENTS.md`.

**Possibly kept as code**, as owner tools or freelancer workspaces:

- The homelab collectors: bounded SSH, k3s and TrueNAS.
- The podman verification sandbox.
- Draft-PR publication through `gh`.

**Retired:**

- The catalog of single-shot capabilities.
- The recipe canvas.
- The job host as the center of the system.
- Chat as the front door.

The ledger idea survives. Its current implementation may not.

## Open questions

1. **Where is the project-manager line?** Can an owner make a one-line fix
   itself, or does every change go through a freelancer? A strict line keeps
   owners cheap and reviewable. A loose one saves round trips.
2. **Freelancer runtime.** What runs a hire: `opencode serve` sessions (any
   provider, per-message model choice), vendor CLIs (`claude -p`,
   `codex exec`), or AgentLayer as today? Decide during the first slice.
   Enforcing a different family for review favors something multi-provider.
3. **Notebook storage.** A Git repository of its own
   (e.g. `~/.local/share/onionsoup/notebooks`), or a directory in this
   repository? Should the format stay close enough to Euclid to reuse its
   tools?
4. **Owner turns.** Which model runs an owner's wakes, and how much notebook
   context fits in a wake before it needs retrieval instead of a prefix?
5. **Leases.** Can a create approval also approve the matching delete at a
   set time, so throwaway resources clean themselves up?
6. **Surface.** Where do the approval inbox, owner status and ledger live? The
   earlier exploration pointed to an opencode server plugin plus an
   openchamber extension, with the runtime as its own service.
7. **Escalation.** When an owner declines a request from another owner, or a
   person's request conflicts with the charter, what happens next?
8. **Approval latency.** Always-on owners will propose plans overnight. How do
   queued approvals expire or get batched?

## First slice

The goal is to test the thesis before building the platform.

1. One repository owner for a small repository, with a charter and an empty
   notebook.
2. Planner, implementer and reviewer freelancers, in at least two model
   families.
3. The change workflow with plan approval, enforced family separation and
   loop limits.
4. Journal and distill.
5. Started by hand on 3–5 real issues first, then from `issue.opened`.

It succeeds if:

- later runs visibly use what the notebook learned from earlier ones;
- cross-family review catches real problems;
- plan approval takes minutes of a person's time, not a review session.

The second slice adds a virtualization owner with read-only nightly duties.
It then exercises owner-to-owner `request.resource` for a test VM, with
create and delete approvals.

## Spike status

The first slice is running as a spike in `packages/owners`, with declarations
in `examples/owners` and state under `.local/owners/`. Run it with
`npm run owners -- <wake|items|show|approve|revise-plan|reject|run|publish|requests|approve-create|approve-delete|deny-request|tick|daemon|distill|notebook|recover>`.

What exists:

- One owner (`clippy`) with a survey duty. The owner has its own clone and
  never edits it.
- Planner, implementer and reviewer freelancers, each hired as a fresh
  `opencode serve` session with structured output validated by Zod.
- The change workflow, with plan approval, owner answers to planner
  questions, host-run verification, a reviewer outside the implementer's
  family, revise and replan loops with limits, and landing as a local commit
  with `Planned-by`, `Implemented-by` and `Reviewed-by` trailers.
- A Git-versioned notebook with a journal, a learnings step and `distill`.

Findings so far:

- **Bash allowlists are not a sandbox.** A "read-only" owner wrote probe
  tests with `cat > file` and ran one that allocated about 47 GB. The
  terminal was OOM-killed. Every hire and every verification run now runs
  under `systemd-run --user --scope` (6 GB, no swap, 512 tasks) inside
  `bwrap` with a read-only root. Only the implementer can write, and only
  its worktree.
- **Freelancer claims are not evidence.** A model reported passing tests
  without running them. The host runs `verify` itself.
- **Unrecorded findings are lost.** The crashed session found a real bug
  (a huge `-font-size` exhausts memory) that the next survey did not
  rediscover. Owners need to journal as they go, not only at the end.
- **opencode 1.18.32 cannot list messages of a session whose prompt used
  `format: json_schema`.** The spike takes the reply from the synchronous
  prompt call, with timeouts disabled, and aborts the session on its own
  deadline instead.
- **Plans need a middle option.** Approve and reject were not enough; a
  person often wants "approve, but also cover X". `revise-plan --note` now
  sends feedback back to the planner, and an approval note reaches the
  implementer and reviewer as conditions of approval.
- **Cost is uneven.** Copilot reports per-call cost; ChatGPT OAuth reports $0.
- **The notebook loop works.** After one landed item and two rejections,
  `distill` moved the rejection reasons from the journal into the registers.
  The next survey, which saw only the notebook, re-proposed the font-size
  bound citing the rejection, did not re-propose the rejected clipboard note,
  did not duplicate the landed tests, and found a new bug (text starting with
  `-` is parsed as a flag). It still proposes some housekeeping churn.
- **Owners need to know what they already did.** Surveys now get recent work
  items with their outcome, including landed work that is only on a local
  branch and therefore invisible in the owner's checkout.
- **Findings are written as they happen.** Every hire gets one writable
  findings file (all other writes stay blocked), and the runtime journals it
  even when the hire fails. opencode matches `edit` rules against the path
  relative to the session worktree, not the absolute path.
- **Publishing is a separate, human-only command.** `publish <item>` pushes
  the landed branch and opens a draft PR whose body carries the plan, the
  host verification, the review and which model did each step. The first
  one is bketelsen/clippy#10.

### Slice 2: a second owner, requests between owners, always on

- `homelab-virt` owns the incus remotes `selfie` (observe only) and
  `minideb` (observe, create, delete). It never gets the incus CLI: host code
  writes a read-only snapshot (`SNAPSHOT.md` plus JSON) into its workspace
  before every wake. Owners without a workflow raise attention items for a
  person instead of work items. Its first health check found a running
  container with no snapshots.
- Owners exchange resource requests. `clippy`'s `distro-smoke` duty asks
  `homelab-virt` for an instance; `homelab-virt` accepts or declines; the
  runtime re-checks the choice (remote allows create, image allowlist, name,
  managed-instance limit). A person approves the create, optionally with the
  delete pre-approved (a lease). The runtime creates the instance, runs the
  requester's follow-up (build clippy in the sandbox, push the binary, run it,
  check the PNG), releases it, and deletes it after the delete approval. An
  owner can only ever delete instances onionsoup created.
- People only record decisions (`approve`, `revise-plan`, `reject`,
  `approve-create [--with-delete]`, `approve-delete`, `deny-request`); the
  runtime acts on them. `owners tick` runs one pass and `owners daemon` runs
  forever; `examples/owners/systemd/onionsoup-owners.service` is a user unit
  that is not installed by anything.
- Found along the way: a requesting owner guessed wrongly what the follow-up
  would do until the brief described it; opencode treats `/` as the worktree
  outside Git, which changes how the findings-file rule must be written;
  `incus launch` reads instance YAML from stdin when it is not a terminal, so
  an open stdin pipe made it wait forever without contacting the server (the
  fake client in tests cannot see this). Every incus call now closes stdin.
- First end-to-end run: clippy asked, homelab-virt accepted, a person
  approved the create with the delete as a lease, and the runtime created
  `minideb:onionsoup-clippy-smoke`, built clippy in the sandbox, ran it on
  Debian 12 (a 371 KB PNG), and deleted the instance. Both notebooks
  journaled every step.

## References

- Replaces the direction of [composable agents](composable-agents.md) and
  [the web operator surface](web.md).
- Notebook model: Euclid brains in Captain Code,
  `docs/EUCLID.md` at <https://github.com/lemma-ventures/captaincode>.
- Carried rules: [AGENTS.md](../../AGENTS.md).
