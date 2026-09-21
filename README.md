# Onionsoup

Small OSS maintenance agents with explicit jobs, shared data contracts, and
inspectable results. Built with [AgentLayer](https://github.com/humanlayer/agentlayer)
and the [12-Factor Agents principles](docs/design/twelve-factors.md).

The first agent is **bug-report readiness**: given one issue snapshot, decide
whether a maintainer has enough information to investigate. It returns a request
`kind` separately from `bug_readiness`. Bug reports are
`ready` or `needs_information`, with quoted evidence and focused questions. Feature
requests, support questions, and other or unclear requests get `not_applicable`;
classification makes no decision about project acceptance.
It does not diagnose the bug or change GitHub.

The second agent is **code-location**: given a ready bug report and a pinned Git
commit, suggest code and tests a maintainer should read. It uses bounded source
inspection and returns exact citations with uncertainties. It does not diagnose
the cause, run repository code, or propose changes.

These agents have an explicit handoff between two narrow jobs.
There is no team scheduler or shared conversation.
The [“taco-bell orchestration” design note](docs/design/composable-agents.md) captures the
goal: multiple orchestration tools composing the same focused agents into
different workflows. The inbox and portable packet demonstrate two consumers.

Start with the [documentation index](docs/README.md) for current contracts,
architecture decisions, historical evidence, and the [roadmap](docs/plans/roadmap.md).

## Start locally

Requires Node 24+ and npm. If managed by mise, use `mise exec node@24.19.0 -- npm ...`.

```sh
npm ci
npm run verify
npm run demo
```

The demo runs the real AgentLayer loop against a **scripted model response**. It
needs no credentials and does not establish model quality. It saves a run record
under `runs/` and prints JSON. All inputs and outputs are local synthetic examples.

## Web operator surface

The job host serves a web app for running and inspecting every registered
capability: repository briefs, issue readiness, code location, investigation
packets and change proposals, plus the homelab capabilities when configured.

```sh
cp examples/job-host/config.json .local/job-host/config.json   # edit repositories and checkouts
npm run build
npm run jobs -- --config .local/job-host/config.json           # open http://127.0.0.1:8787
```

Browser input only picks configured repositories and prior jobs by ID. Checkout
paths, credentials, providers and models come from the configuration file.
See [the web design page](docs/design/web.md).

## Compose or deploy a repository brief

The first portable slice uses private workspaces in `packages/` and thin hosts in
`apps/`. Import `@onionsoup/repository-analysis` for focused agent calls, or
`@onionsoup/repository-brief` for the complete recipe. CLI, scheduled delivery and
MCP delegate to that same implementation. Root source remains for other workflows
and compatibility imports.

```sh
npm run repo-brief -- OWNER/REPO --days 7
npm run delivery -- tick /absolute/config.json --state /absolute/state
npm run release:brief
```

Copy `dist/repository-brief` to deploy, then run `npm ci --omit=dev --ignore-scripts`
and `node verify-release.mjs` there. Compiled hosts run on Node 24+ without `tsx`.
For chat-agent orchestration, use `npm run mcp:brief` during development or launch
`apps/brief-mcp/dist/main.js` from the release. Configure an explicit provider,
repository allowlist and run directory; its tools submit, inspect and cancel bounded
jobs. The original `npm run mcp` command remains separate.

See the [package/host contract](docs/specs/workspace-packages.md) for configuration,
release checks and recovery, and [the design](docs/design/packages-and-recipes.md)
for composition and the future homelab direction.

## Read-only homelab first contact

`npm run homelab -- truenas /absolute/path/to/target.json` collects a sanitized
snapshot through an existing TrueNAS MCP executable. Credentials stay in its
external environment; writes are explicitly disabled. This evidence-source step
uses no model and keeps unknown sections separate from healthy observations.
See [the TrueNAS contract](docs/specs/truenas-evidence.md) for configuration and limits.

`npm run homelab -- containers /absolute/path/to/target.json` collects Docker,
Podman and Incus state counts through fixed SSH inspection commands. It uses existing
keys and strict host-key trust, preserving unavailable tools separately from empty
inventories. See [the SSH inventory contract](docs/specs/container-inventory.md).

## Use a subscription

Copilot is the default provider; Codex is also supported. There is no silent
fallback between providers, and no API-key billing path in this proof of concept.

```sh
npm run triage -- login copilot
npm run triage -- models
export ONIONSOUP_MODEL=gpt-5.6-terra
npm run triage -- run examples/incomplete-bug.json
```

`gpt-5.6-terra` is the current evaluation model. Model comparisons are deferred;
prior comparisons remain historical evidence. New credentials are stored in the
ignored `.local/auth.json`, with mode 0600.

Existing AgentLayer or OpenCode credentials can be read directly:

```sh
export ONIONSOUP_AUTH_PATH="$HOME/.local/share/opencode/auth.json"
export ONIONSOUP_PROVIDER=copilot
export ONIONSOUP_MODEL=gpt-5.6-terra
npm run triage -- run examples/incomplete-bug.json
```

For Codex, set `ONIONSOUP_PROVIDER=codex` and a model supported by that subscription.
Use `npm run triage -- login codex` if the selected credential store has no Codex
entry. Provider token refresh may update the selected store. `models` currently
lists Copilot models only. Both adapters are included; the validation report records
which providers have actually been exercised.

To assess a GitHub issue's title and body, fetch a snapshot outside the agent:

```sh
gh api repos/OWNER/REPO/issues/NUMBER --jq '
  if .pull_request then error("Expected an issue, received a pull request")
  else {schemaVersion: 1, repository: "OWNER/REPO", number,
        updatedAt: .updated_at, title, body: (.body // "")} end' > issue.json
npm run triage -- run issue.json
```

Replace `OWNER/REPO` and `NUMBER` in both places. This agent assesses only the
supplied title/body, so start with new reports; it does not read comments or linked
attachments. Keep the source revision with the result and reassess if it changes.

## Produce a repository brief

```sh
npm run repo-brief -- get-bb/bb --days 7 --max-suggestions 5
npm run repo-brief -- render runs/repository-briefs/DIRECTORY
```

Scheduled brief delivery uses a host adapter and a saved-message ledger. Start with
local capture (no forwarding):

```sh
mkdir -p .local
cp examples/delivery/config.json .local/delivery.json
npm run mail-capture -- .local/mail-capture
# In another terminal, after configuring recipient/schedule:
npm run delivery -- tick .local/delivery.json
```

The example selects 08:00 America/New_York. See the
[delivery contract](docs/specs/scheduled-delivery.md) for systemd scheduling,
preparing an existing brief, explicit retries, and reconciliation of unknown sends.


This on-demand report combines issue/PR counts and themes, closure/merge activity,
first-time PR authors, CI statistics, health observations and up to N suggested
maintainer actions. Deterministic code calculates counts; three focused agents
handle themes, interpretation and proposals under four shared attempts.

Configure `gh` and your subscription first. No target checkout is needed. Output
includes Markdown, browsable HTML, JSON evidence and a common trace. Sampling,
missing data and metric definitions stay visible. Copilot/Terra is the default;
`--provider codex` selects that subscription. See the
[contract and bounds](docs/specs/repository-brief.md) and
[package/recipe/adapter design](docs/design/packages-and-recipes.md). Scheduled
email, webhooks and MQTT adapters are documented future work.

## Use the maintenance inbox

```sh
npm run inbox -- refresh get-bb/bb
```

With the subscription configured above, this fetches a bounded window of GitHub
issues and assesses up to five new or changed reports with Terra. Open
`runs/inbox/get-bb--bb/index.html` to browse the results, proposed questions,
waiting reports, and failures. There are no grading forms or GitHub writes.
Unchanged title/body content is reused; explicit retries preserve earlier attempts.
See [the inbox guide](docs/specs/inbox.md) for bounds, freshness, recovery, and commands,
and [the live pilot record](docs/plans/records/inbox-pilot-2026-09-18.md) for operational results.

## Evaluate and inspect

```sh
npm run eval
```

This runs twelve synthetic development cases through **gpt-5.6-terra** on the
configured live subscription and uses its quota. Evaluation pins Terra explicitly;
`ONIONSOUP_MODEL` remains available for individual `triage run` invocations.
Expected outcomes are held outside the prompt. Run records include
the snapshot, its hash, model/provider, prompt version, timestamps, step/tool events,
usage reported by AgentLayer, termination reason, and final AgentLayer state.
See [validation](docs/design/validation.md) for measured results and limitations.
The [first real-issue pilot](docs/plans/records/bb-pilot-2026-09-18.md) exposed judgment failures
in the mini model; do not infer task reliability from the offline demo or the
original six-case result.

For a frozen Terra-only real-issue batch with human feedback, use the
[batch evaluation workflow](docs/specs/batch-evaluation.md). The historical
[40-issue Terra/Luna evaluation](docs/plans/records/bb-heldout-2026-09-18.md) keeps runtime
success separate from human acceptance and requires an explicit cost decision
before recommending a supervised pilot.

`ONIONSOUP_RUNS_DIR` changes the output directory. Run files contain issue text and
model output; keep them local. A failed run exits nonzero. A valid assessment exits
zero, including non-bug classifications, because the
assessment itself succeeded. New outputs use contract v2 and prompt v4; historical
v1 outputs retain their original labels and can still receive feedback.

## Repository skills and contracts

The four foundational skills in [.agents/skills/](.agents/skills/) cover [scope/contracts](.agents/skills/agent-contract/SKILL.md),
[prompts/context](.agents/skills/agent-context/SKILL.md), [execution/recovery](.agents/skills/agent-execution/SKILL.md),
and [evaluation/visibility](.agents/skills/agent-evaluation/SKILL.md). [AGENTS.md](AGENTS.md)
provides canonical instructions; tool-specific paths and the legacy `skills` path
are symlinks. The [repository design](docs/design/repository-layout.md) describes
the adopted agentic-template conventions.

The [readiness contract](docs/specs/bug-readiness.md) and
[code-location contract](docs/specs/code-location.md) explain success, evidence,
authority, failure, and handoff. [The twelve-factor mapping](docs/design/twelve-factors.md)
explains what is implemented now and what is intentionally deferred. These
contracts are the starting point for a future team; there is no team runtime yet.

The [twenty-factor follow-through backlog](docs/plans/backlog.md) adds eight focused
authoring skills for discovery, observability, budgets, releases, authority,
durability, automated quality review, and repository knowledge. The canonical
[skill routing](AGENTS.md) lists when to use each.

## Discover agents and inspect workflows

```sh
npm run agents -- list
npm run agents -- describe code-location
npm run agents -- events runs/packets/PACKET_DIRECTORY
```

The [capability catalog](capabilities/catalog.json) publishes versioned schemas,
callable entry points, effects, bounds, and failure semantics. Event exports work
without credentials or model calls and distinguish fresh work from reused results.
See the [discovery contract](docs/specs/agent-discovery.md).

New code-location v3 briefs label selected tests **direct** or **adjacent** and
explain whether the bounded test search was **completed** or **unfinished**.
These are model judgments, not measured coverage. Historical briefs retain their
original fields. The [status report](docs/plans/records/relevance-and-discovery-2026-09-18.md)
records the live trial and its limitations.

## External consumer: Codex through MCP

The [local MCP adapter](docs/specs/mcp-adapter.md) lets Codex discover the agents,
invoke the existing bug-readiness agent, and inspect its result and workflow
events. Launch configuration fixes the provider, model, private artifacts, and
invocation allowance (default one). See the spec for configuration and the
repeatable `npm run prove:codex -- SNAPSHOT.json` integration proof.


A [bounded multi-issue recipe](docs/specs/readiness-workflow.md) handles up to five
snapshots under the same server allowance as single calls, with explicit partial
outcomes. For model consumers, prepare inputs once and invoke them by hash to
preserve full issue bodies. `npm run prove:codex -- --workflow THREE_ISSUES.json`
proves three issues with a budget of two; the third remains explicitly unattempted.


Optional [pinned-source handoffs](docs/specs/location-handoff.md) let the consumer
select a saved ready run for code-location under the same allowance. The host owns
checkout and commit selection. See `npm run prove:codex -- --handoff ONE_ISSUE.json`
and the spec for the three source settings.


The [web operator surface](docs/design/web.md) replaced the former loopback console. The
[investigation-to-PR plan](docs/plans/investigation-to-pr.md) records the proposed
next boundaries for bugs and features: distinct evidence/requirements preparation,
a shared change proposal, isolated verification, patch/review, and explicitly
authorized draft publication. Current feature classification still makes no project
acceptance decision. Read-only feature preparation and shared proposals are now implemented; owned-fixture execution is implemented; real-project execution and publication remain planned.

## Isolated fixture runner and patch agent

The [owned fixture workflow](docs/specs/fixture-execution.md) now exercises one bug
and one feature through a deterministic rootless Podman runner, scoped patch agent,
exact diff reconstruction and separate model review. It executes only the bundled
dependency-free fixture, with no target GitHub writes or publication authority.

```sh
npm run fixture -- pin --image LOCAL_TRUSTED_IMAGE --output .local/fixture/runtime.json
npm run fixture -- patch bug --runtime .local/fixture/runtime.json --output runs/NEW_BUG --provider copilot
npm run fixture -- patch feature --runtime .local/fixture/runtime.json --output runs/NEW_FEATURE --provider copilot
```

The image must already be available locally; pinning never pulls or changes host
image policy. Add its saved run parent to the console's `fixtureRoots` to browse
**Fixture trials**. See the [trial evidence](docs/plans/records/fixture-patches-2026-09-19.md)
for successful candidates, blocked initial diffs, isolation checks and limitations.

### Owned-fixture draft publication

Prepare and inspect a concrete bundle, record existing operator authorization, then publish or reconcile it with `npm run publication --`. The [publication contract](docs/specs/draft-publication.md) lists commands and host configuration. The console exposes `/publications` when `publicationConfig` is configured. Only exact configured `bketelsen/*` targets are supported; no merge or external OSS publication.

### Accepted proposal to an owned-project change

`npm run project-change --` exposes the first [real-project profile](docs/specs/owned-project-changes.md): propose, accept, provision dependencies, execute a bounded candidate, and prepare its publication bundle. The initial task is publication-status filtering; source, dependencies and checks are pinned separately, and the feature is delivered as a draft PR.

## Homelab observations and brief

Read-only sources cover TrueNAS, Docker/Podman/Incus, and k3s/Argo CD. The
[homelab brief contract](docs/specs/homelab-brief.md) documents private host configs,
fixed commands, access boundaries and saved-source composition.

```sh
npm run homelab -- kubernetes .local/homelab/kubernetes.json
npm run homelab -- brief .local/homelab/brief.json --output runs/NEW_BRIEF
```

The brief combines explicit saved observations without network or model calls.
It shows independent cluster readiness and GitOps health/sync, with missing
coverage, collection times and source hashes. It does not refresh or repair services.

The [workload triage agent](docs/specs/workload-triage.md) adds evidence-linked
Attention findings and can be called by a homelab chat agent through local MCP:

```sh
npm run homelab -- investigate .local/homelab/kubernetes.json --provider copilot
ONIONSOUP_HOMELAB_CONFIG=.local/homelab/mcp.json npm run mcp:homelab
```

Set subscription auth through `ONIONSOUP_AUTH_PATH`. The MCP host exposes discovery,
configured workload investigation, saved-source brief creation, inspection and
cancellation; it has no repair tools.
