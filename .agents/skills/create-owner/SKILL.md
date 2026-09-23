---
name: create-owner
description: Creates a new onionsoup owner (declaration, charter draft, desk, OpenChamber project) in the person's config directory. Use whenever asked to create, add, hire or declare an owner, or to put someone in charge of a repository, org, host or service.
---

# Create an owner

Done means the new owner validates, has a desk and an OpenChamber project, its config is committed in the
person's config repo, and the person knows to restart OpenChamber's opencode and rewrite the charter.

A steward (an owner with `manages:`, such as Odrade for Frostyard) does this through its `onionsoup_owners` tool,
which validates, asks the person and commits; steps 7 and 9 are then done for it.

Owners are configuration, not engine code. The config directory is `$ONIONSOUP_CONFIG`, by default
`~/.config/onionsoup`. It is a local Git repository and is never pushed. [docs/extending.md](../../../docs/extending.md)
is the reference; the schema is `packages/owners/src/declarations.ts`.

## Steps

1. Settle with the person: the domain, what the owner is for, and what it may do. Ask; don't assume authority.
2. Pick the domain kind:
   - `git-repository`: verify commands, change workflow, `maintain-prs` duty.
   - `repository-group`: several related repositories under one owner, each with its own verify commands
     (see docs/extending.md). Group by topic and coupling; keep a critical repository on its own.
   - `incus`: instances, create/delete behind `allow` and gates.
   - `truenas`: truenas-mcp, sites.
   - `github-org`: a read-only gh snapshot.

   Anything else is engine work: see [gaps.md](../../../docs/gaps.md) and the operate-onionsoup skill.
3. Name it. Owners are Dune characters from Heretics, Chapterhouse and God Emperor. Important domains get main
   characters; small repos get tertiary names or the repo's own name. Read `owners/*.yaml` first so you don't
   reuse a name.
4. Pick the model and check families. Look up the model's family in `families.yaml`. The reviewer freelancer must
   be from a different family than the implementer, and the owner's model is usually fine from either.
5. Write `owners/<id>.yaml`. Copy the closest existing owner, not the starter example.
   - Keep `conversation:` narrow: allow reads and the domain's verify commands, and `ask` for everything else.
   - Add `mcp:` servers with per-tool rules when a tool already exists.
   - Duties: add `every:` only when the person wants the owner always on.
6. Write `charters/<id>.md`. Headings: Domain, Goals, Boundaries, How to work. Start it with
   `DRAFT written by <you>. The human owner should rewrite this.`
7. Validate with `npm run owners -- items`. It loads and validates every declaration, and fails with the
   offending path.
8. For git-repository owners, run each verify command once in the sandbox via a `wake` or a manual check. Every
   command must pass on the base branch, or every change the owner makes will fail verification.
9. Provision the owner and commit:
   - Run `npm run owners -- sync-openchamber`, which creates the desk and OpenChamber project (the daemon also
     does this every minute).
   - Commit in the config repo: `git -C ~/.config/onionsoup add -A && git -C ~/.config/onionsoup commit -m "Add <Name> (<domain>)"`.
10. Tell the person to restart OpenChamber's opencode so the plugin loads the new agent, and to rewrite the charter.

## Pitfalls

- **Grants:** never add `grants:` or incus `allow` entries the person did not ask for. Grants replace their
  approval.
- **Secrets:** go in an `envFile` outside Git. Name the variables and never print their values.
- **Verify commands:** a command needing root, the network or a daemon fails in the sandbox (read-only root,
  6G memory, no host-only env). Pick static checks and leave builds to CI; snosi's mkosi builds are the example.
- **Watching:** an owner that only watches needs `edit: deny` and read-only bash rules; Odrade is the example.
