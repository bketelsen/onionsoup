# Onionsoup

Onionsoup runs **owners**: persistent AI agents that each own one part of your world, such as a repository,
your virtualization hosts, your NAS or your wiki. Owners have names and personalities, keep a notebook of
what they learn, talk to each other, and get work done by hiring **freelancers** (planners, implementers,
reviewers) under rules the runtime enforces: your approval for plans and destructive actions, verification by
host code in a sandbox, and review by a different model family.

You talk to owners in [OpenChamber](https://github.com/openchamber/openchamber) or the opencode TUI: start a
chat with Bellonda, keeper of the homelab wiki, and she answers from her notebook, asks the owner of the NAS
when a question is his, and turns your decisions into reviewed changes.

## Quick start

```bash
npm ci
npm run owners -- init                 # your owners live in ~/.config/onionsoup, not in this repository
npm run owners -- sync-openchamber     # each owner gets a desk and an OpenChamber project
npm run owners -- daemon               # always on: duties, requests, work items
```

Register the plugin so owners become opencode agents (`~/.config/opencode/opencode.json`):

```json
{ "plugin": ["file:///path/to/onionsoup/packages/owners/src/plugin.ts"] }
```

Then read [creating your own owners and tools](docs/extending.md).

## What is here

| Path | What it is |
| --- | --- |
| `packages/owners` | The engine: runtime, CLI (`npm run owners -- <command>`), opencode plugin, daemon |
| `extensions/owners-desk` | The Owner's Desk: an OpenChamber panel for an owner's identity, gates, activity and notebook |
| `examples/starter` | The configuration `owners init` copies: one example owner, freelancers, a workflow, rubrics |
| `deploy/onionsoup-owners.service` | A systemd user unit for the daemon |
| `docs/` | [Design](docs/design/owners.md), [extending](docs/extending.md), [gaps](docs/gaps.md) |

## Commands

```
owners init | sync-openchamber | daemon | tick
owners wake <owner> <duty> | distill <owner> | ask <from> <to> --note "question"
owners items | show <item> | approve <item> [--note] | revise-plan <item> --note | reject <item> --reason | resume <item>
owners run <item> | publish <item> | propose <owner> --note "title"
owners requests | approve-create <request> [--with-delete] | approve-delete <request> | deny-request <request> --reason
owners approve-push <item> | request-publish <owner> <site> | desk <owner> | notebook <owner>
```

## Develop

`npm run verify` builds, checks package boundaries and docs, typechecks and runs the tests. Conventions for
people and agents working on the code are in [AGENTS.md](AGENTS.md).
