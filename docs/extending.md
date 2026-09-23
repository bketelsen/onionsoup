# Creating your own owners and tools

Onionsoup is the engine; your owners are configuration in your own directory (`~/.config/onionsoup` by
default, or `ONIONSOUP_CONFIG`). Nothing about your owners lives in this repository, and adding an owner or a
tool needs no onionsoup code.

## Start

```bash
git clone https://github.com/bketelsen/onionsoup && cd onionsoup && npm ci
npm run owners -- init            # creates ~/.config/onionsoup from examples/starter, as its own Git repo
```

Then register the plugin with opencode, so your owners become agents you can chat with
(`~/.config/opencode/opencode.json`):

```json
{ "plugin": ["file:///path/to/onionsoup/packages/owners/src/plugin.ts"] }
```

Requirements: Node 24, opencode (logged in to the providers your owners use), `bwrap` and `systemd-run`
(the sandbox), Git and `gh`. OpenChamber is optional but recommended.

## Create an owner

1. Copy `owners/example.yaml` to `owners/<id>.yaml` and edit it: persona, domain, model, conversation rules,
   duties. Write `charters/<id>.md` yourself: it steers everything the owner does.
2. Run `npm run owners -- sync-openchamber` (the daemon re-reads your configuration and does this every minute): the owner gets a desk and an
   OpenChamber project with itself as the default agent.
3. Restart opencode (or OpenChamber's opencode) so the plugin picks up the new agent.
4. Talk to it. Run its duties with `npm run owners -- wake <id> <duty>`, or leave it to the daemon.

### Own several repositories together

Related repositories can share one owner. Each repository keeps its own verification; work items, proposals and
desk changes name the repository they are in, and the desk is a folder with one worktree per repository.

```yaml
domain:
  kind: repository-group
  name: frostyard/image-platform
  repositories:
    - { name: frostyard/lab, remote: git@github.com:frostyard/lab.git, baseBranch: main, verify: [[make, check]] }
    - { name: frostyard/testsuite, remote: git@github.com:frostyard/testsuite.git, baseBranch: main, verify: [[go, test, ./...]] }
```

A group owner cannot be a site source or ship (both need exactly one repository).

## Give an owner tools

Any MCP server can be an owner's tool, visible to that owner alone:

```yaml
mcp:
  github:
    command: [github-mcp-server, stdio]
    envFile: ~/.config/onionsoup/secrets/github.env   # KEY=VALUE lines; values are never logged
    rules:
      "*": allow                   # the server's tools, by name
      create_pull_request: ask     # the person approves in the chat
      delete_repository: deny      # hidden from the owner entirely
```

Everything else follows the owner's `conversation:` rules: `allow`, `ask` (approve in the chat) or `deny`.

## Give an owner authority

Authority comes only from your configuration:

- `domain.incus.remotes[].allow` decides where instances may be created and deleted.
- `grants:` are standing approvals: `{ to: <owner>, action: publish-site | update-app | merge | ship, target: <name or "*"> }`.
  Without a grant, the runtime asks you.
- `manages: { owners: [<glob>, ...] }` makes an owner a steward: with its `onionsoup_owners` tool it creates,
  changes and retires owners whose domain (repository or org name) matches, with your approval for each write. It
  can never write `grants`, `deploy`, `incus`, `mcp` or `manages`, nor change itself.
- `deploy: { checkout, services }` says where a repository owner's code runs; with it the owner can ship
  (fast-forward, verify, restart with a health check and rollback).
- Destructive actions, plan approval and creates/deletes always stop for you unless a grant says otherwise.

## Run it always on

```bash
cp deploy/onionsoup-owners.service ~/.config/systemd/user/     # adjust WorkingDirectory and PATH
systemctl --user daemon-reload && systemctl --user enable --now onionsoup-owners
```

Install the Owner's Desk in OpenChamber (Settings → Extensions → Add → `extensions/owners-desk`).

## What needs engine code

New domain kinds (how an owner observes and changes something, like `git-repository`, `incus`, `truenas`, `github-org`), new
request kinds, and new duty kinds are engine code in `packages/owners`. See [gaps.md](gaps.md) for what is
missing, and the [design](design/owners.md) for how the pieces fit.
