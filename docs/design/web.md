# Web operator surface

Living document. Supersedes the CLI-per-recipe and loopback-console approach.

## Shape

- **API:** `@onionsoup/job-host` (`apps/job-host`). Capabilities are registered at
  launch from operator configuration. Endpoints:
  `GET /v1/capabilities`, `GET /v1/jobs`, `POST /v1/jobs`, `GET /v1/jobs/:id`,
  `POST /v1/jobs/:id/cancel`, `GET /v1/events` (server-sent job transitions).
  The host also serves the built web app from a configured directory on the
  same origin.
- **Web app:** `apps/web`, Svelte + Vite. Forms are generated from each
  capability's JSON schema. Job history and status update live over the event
  stream. Results render as structured views where a renderer exists and as
  JSON otherwise.
- **Access:** on loopback the browser is the configured `web` invoker without a
  token; same-origin requests only. Remote invokers (chat, scheduler) keep bearer
  tokens. Tailscale identity is the planned remote-access path.

## Running it

```sh
cp examples/job-host/config.json .local/job-host/config.json   # edit repositories, invokers
npm run build                                                  # compiles packages and the web app
npm run jobs -- --config .local/job-host/config.json           # http://127.0.0.1:8787
npm run web:dev                                                # optional: Vite dev server proxying /v1 to the host
```

Provider sign-in comes from `ONIONSOUP_AUTH_PATH` (default `.local/auth.json`);
GitHub reads use the authenticated `gh` CLI.

## Phases

1. Host serves the SPA; capability list, schema forms, job list and detail, live
   status. Run `repository.brief` end to end. *(in progress)*
2. Move readiness, code-location, packet and change-proposal from `src/` into
   packages and register them as capabilities. Retire their CLIs.
3. Evidence views for briefs, packets, proposals, events, citations, deliveries
   and fixtures. Retire `src/console`.
4. Recipes: a saved document of steps, bindings and budgets; the host runs it as
   a parent job with child jobs; a Svelte Flow canvas edits it.
5. Web chat over `@onionsoup/chat` with tools that are host capabilities and
   saved recipes. Retire the chat CLI.
6. Tailnet hosting with Tailscale identity; homelab capabilities in the same
   catalog.

Fixture execution, draft publication and owned-project changes stay on their
CLIs until the read-only surface is done; they carry real effects.

## Rules kept from the proving phase

Browser input picks configured targets by ID and never paths, credentials,
commands, providers or models. Every job persists before it runs and after it
finishes; interrupted jobs are never replayed automatically. Completed means a
validated artifact exists; the artifact's own partial or failed status stays
visible.
