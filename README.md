# Onionsoup

Onionsoup runs **owners**: persistent AI agents that each own one part of your world, such as a repository,
your virtualization hosts, your NAS or your wiki. Owners have names and personalities, keep a notebook of
what they learn, talk to each other, and run their own work with **skills** (adapted from obra/superpowers) and
**subagents** (an implementer, and a reviewer from another model family) under rules the runtime enforces: your
approval for plans and destructive actions, verification by host code in a sandbox, and a required review by a
different model family before anything is committed.

You talk to owners in the onionsoup **surface** (a web app built on opencode) or the opencode TUI: start a chat with
Bellonda, keeper of the homelab wiki, and she answers from her notebook, asks the owner of the NAS
when a question is his, and turns your decisions into reviewed changes.

Owners use `onionsoup_send` and `onionsoup_reply` for addressed conversation in their actual work sessions,
including manager rulings and corrections. Busy sessions receive queued messages when idle; retired workspaces
get a fresh continuation without replacing the original request. `onionsoup_ask` stays a separate read-only
consultation, and informational progress notices do not wake an owner.

Deliberately stopped work has an explicit paused lifecycle rather than appearing to run indefinitely.
Paused work retains its approved goal and history, and only an authorized explicit resume restarts it.
Published PR maintenance distinguishes a branch behind its base from a conflicting branch: clean
updates preserve its published commits and run host checks without adding a new approval ceremony.
Approved infrastructure/E2E work can complete without a PR through original-goal-bound host checks,
supported effect receipts and one final independent-family review; owner reports alone never suffice.

## Quick start

```bash
npm ci
npm run owners -- init                 # your owners live in ~/.config/onionsoup, not in this repository
npm run owners -- daemon               # always on: duties, requests, work items
npm run surface:build && npm run surface   # owners, chats and your inbox at http://127.0.0.1:4747
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
| `packages/surface` | The surface: a server over opencode and the engine, and a web UI for owners, their chats and one inbox |
| `examples/starter` | The configuration `owners init` copies: one example owner and its charter, the implementation and review models, model families |
| `deploy/` | systemd user units for the daemon, surface and calendar briefings |
| `docs/` | [Design](docs/design/owners.md), [extending](docs/extending.md), [gaps](docs/gaps.md) |

## Commands

```
owners init | daemon | tick
owners wake <owner> <duty> | distill <owner> | ask <from> <to> --note "question"
owners items | show <item> | approve <item> [--note] | revise-plan <item> --note   # plans waiting in the inbox
owners pause <item> --reason | resume <item> [--note] | retry <item> [--note] | cancel <item> --reason | run <item> | propose <owner> --note "title"
owners requests | approve-create <request> [--with-delete] | approve-delete <request> | deny-request <request> --reason
owners approve-push <item> | request-publish <owner> <site> | desk <owner> | notebook <owner>
```

## Develop

`npm run verify` builds, checks package boundaries and docs, typechecks and runs the tests. Conventions for
people and agents working on the code are in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE). The surface's UI borrows styles and chat markup from
[OpenChamber](https://github.com/openchamber/openchamber), also MIT; see `packages/surface/web/NOTICE`.
