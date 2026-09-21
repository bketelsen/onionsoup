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

## Working here

- `npm run verify` builds, checks package boundaries and doc links, typechecks
  and runs tests. Keep it green.
- Provider and model are selected at the application edge; use `gpt-5.6-terra`
  for development runs. See `packages/providers`.
- Write readable code. Normal formatting, one statement per line. Reformat dense
  legacy files as you touch them.
- Docs: one living design page per area under `docs/design/`. Update it when
  reality changes. `docs/adr/`, `docs/specs/` and `docs/plans/records/` are
  history from the proving phase; do not extend them. Historical evaluation
  records keep their original findings.
- Keep credentials, private keys, raw runs and local clones out of Git. Never
  log credentials.
