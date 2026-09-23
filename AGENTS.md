# Onionsoup

Owners: persistent agents that each own one domain, hire freelancers, and work under runtime-enforced gates.
Read [docs/design/owners.md](docs/design/owners.md) first, then [docs/gaps.md](docs/gaps.md).

`AGENTS.md` is canonical; `CLAUDE.md` and `GEMINI.md` are symlinks to it.

## Rules that matter

1. **Authority comes from configuration, never from model or chat input.** Repositories, hosts, credentials,
   models and grants are declared in the person's config directory; a request picks among declared things.
2. **Effects happen in host code, behind gates.** Plan approval, creates/deletes and destructive actions wait for
   a person unless a standing grant in configuration says otherwise, and every use of a grant is journaled.
3. **The sandbox is the boundary.** Model-driven processes and verification run in bwrap with a read-only root
   inside a memory-capped systemd scope. Bash allowlists are a convenience, never a security boundary.
4. **Freelancer claims are not evidence.** Host code runs verification; reviews come from another model family.
5. **Deterministic first.** Periodic checks are host code; they wake a model (the owner) only when needed.

## Layout

- `packages/owners`: the engine (`@onionsoup/owners`): runtime, CLI, daemon, opencode plugin (`src/plugin.ts`).
- `extensions/owners-desk`: the OpenChamber extension (service + panel, built with `npm run desk:build`).
- `examples/starter`: the configuration `owners init` copies. A person's own owners never live in this repository
  (`ONIONSOUP_CONFIG`, default `~/.config/onionsoup`); state lives in `ONIONSOUP_HOME`.
- `packages/owners/test/fixtures/owners`: declarations the tests use.
- Runtime limits are named constants with defaults, not contracts. Relax them when they get in the way.

## Code rules

These are the patterns that slip through when nobody is looking. Reviewers
reject them; fix them when you touch a file that has them.

- **Dispatch through data, not conditionals.** A chain of `if`/`else if` or a
  `switch` that selects behavior by an ID, kind or type is a lookup table:
  `Record<Id, Handler>` plus one fallback. Adding a case must not touch the
  dispatcher. This applies to renderers, validators, command handlers and
  event mappers alike.
- **One statement per line, one job per function.** No semicolon-joined
  statements, no 300-character lines, no functions longer than a screen. If a
  function needs a comment to separate its phases, split it.
- **Name the thing.** No single-letter identifiers outside a two-line lambda.
  No `data`, `result2`, `tmp`, `flag`. Booleans read as predicates
  (`isReady`, `hasCheckout`).
- **Parse at the edge, trust inside.** Validate input once with a schema at the
  boundary (HTTP, file, model output) and pass typed values inward. No
  re-validating the same object in three places, no `as any` to skip it.
- **No duplicated shape knowledge.** A JSON shape lives in one Zod schema and
  its inferred type. If two modules both know a field name, one of them imports
  it from the other.
- **Errors carry a reason.** Throw or return a specific code the caller and the
  UI can show (`readiness_not_eligible`, not `failed`). Never swallow an error
  into a generic message unless the original is a credential or transport
  detail that must not leak.
- **Limits are configuration.** Numbers that bound behavior are named constants
  with defaults that a config can override, not literals in the logic.
- **Components take one prop shape.** A UI renderer takes the whole result and
  destructures inside, so a registry can instantiate any of them the same way.
- **Delete, don't deprecate.** When something is replaced, remove it and its
  tests in the same change. Git history keeps it; dead code does not stay.
- **Tests exercise the seam, not the mock.** A test that only asserts what a
  fake returned proves nothing. Test through the public function with a
  scripted model or fixture and assert on persisted records.

## Working here

- `npm run verify` builds, checks package boundaries and doc links, typechecks and runs tests. Keep it green.
- The running daemon (`onionsoup-owners.service`) and OpenChamber's opencode load this code: restart them after
  changes that should take effect.
- Docs: one living design page (`docs/design/owners.md`), the gaps list and the extending guide. Update them when
  reality changes.
- Keep credentials, private keys, raw runs and local clones out of Git. Never log credentials.
