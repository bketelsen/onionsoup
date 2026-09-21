# Onionsoup

Single-purpose agents for OSS maintenance and homelab work, composed into
workflows. One job per agent. The shared job host is the API; the web app in
`apps/web` is the operator surface. Read [docs/design/web.md](docs/design/web.md)
first, then [docs/README.md](docs/README.md) for the rest.

`AGENTS.md` is canonical; `CLAUDE.md` and `GEMINI.md` are symlinks to it.
Skills under `.agents/skills/` are reference material, not required reading.

## Two rules that matter

1. **Browser and model input never select authority.** Paths, credentials,
   commands, providers, models, SSH hosts and repositories come from operator
   configuration. A request picks among configured things by ID.
2. **Effects are explicit.** Anything that writes to GitHub, executes code, or
   mutates a service stays behind a deliberate approval step and is recorded.
   Read-only agents get no write tools.

Everything else is ordinary engineering judgment.

## Layout

- `packages/*`: `@onionsoup/*` workspaces. Import only declared exports. Never
  import root `src/` or an app from a package.
- `apps/*`: thin hosts (job host, web, MCP servers, CLIs). CLIs are being retired
  as the web app replaces them.
- `src/`: legacy OSS-maintenance workflows (readiness, location, packet, proposal,
  fixture, publication). Move a module into a package when the job host needs it.
- Runtime limits (quotas, queue size, deadlines) are configuration with defaults,
  not contracts. Relax them when they get in the way.

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
- **Delete, don't deprecate.** When the web replaces a CLI or a module, remove
  it and its tests in the same change. Historical records stay; dead code does
  not.
- **Tests exercise the seam, not the mock.** A test that only asserts what a
  fake returned proves nothing. Test through the public function with a
  scripted model or fixture and assert on persisted records.

## Working here

- `npm run verify` builds, checks package boundaries and doc links, typechecks
  and runs tests. Keep it green.
- Provider and model are selected at the application edge; use `gpt-5.6-terra`
  for development runs. See `packages/providers`.
- Write readable code; the rules below are checked in review. Reformat dense
  legacy files as you touch them.
- Docs: one living design page per area under `docs/design/`. Update it when
  reality changes. `docs/adr/`, `docs/specs/` and `docs/plans/records/` are
  history from the proving phase; do not extend them. Historical evaluation
  records keep their original findings.
- Keep credentials, private keys, raw runs and local clones out of Git. Never
  log credentials.
