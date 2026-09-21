# Web operator surface

Living document. Supersedes the CLI-per-recipe and loopback-console approach.

## Shape

- **API:** `@onionsoup/job-host` (`apps/job-host`). Capabilities are registered at
  launch from operator configuration. Endpoints:
  `GET /v1/capabilities`, `GET /v1/jobs`, `POST /v1/jobs`, `GET /v1/jobs/:id`,
  `POST /v1/jobs/:id/cancel`, `GET /v1/events` (server-sent job transitions),
  `GET|PUT|DELETE /v1/recipes[/:id]`, and `/v1/chat/sessions[/:id[/turns]]`.
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
   status. Run `repository.brief` end to end. *(done 2026-09-21)*
2. Readiness, code-location, packet and change-proposal live in
   `@onionsoup/maintenance` and are registered as `issue.readiness`,
   `code.location`, `investigation.packet` and `change.proposal`. Root `src/`
   files forward to the package for the remaining legacy consumers. The
   `locate`, `packet`, `proposal` and `briefing` CLIs are gone. *(done 2026-09-21)*
3. Job results render as evidence: readiness assessments with quoted evidence
   and questions, location citations linked to the pinned commit on GitHub,
   packets and briefs as Markdown, related jobs by ID, and next-step links
   (locate code for a ready bug, draft a proposal from a packet). The loopback
   console under `src/console` is deleted. Scheduled-delivery pause/resume and
   publication approval are CLI-only until they get a web equivalent.
   *(done 2026-09-21)*
4. Recipes: a saved document of steps with bindings; the host runs one as a
   parent job whose steps are ordinary child jobs; a Svelte Flow canvas edits
   it. *(done 2026-09-21)*
5. Implementation behind approval: `change.approve` (a person fixes the task
   and files from a completed proposal), `change.implement` (project proposal,
   acceptance, pinned dependencies, patch and review agents, sandbox checks),
   `change.publish` (a person opens the draft PR). The pipeline modules live in
   `@onionsoup/implementation`. Approve and publish are interactive: the host
   refuses them as recipe steps. *(done 2026-09-21; live sandbox run pending
   an operator-pinned runtime)*
6. Web chat: `@onionsoup/host-chat` is a chat profile whose tools are the
   host catalog (discover, list jobs, run a capability or recipe, inspect a
   job). Interactive capabilities are refused; answers must cite jobs
   inspected in the turn. Sessions persist under `<state>/chat/<id>` with an
   owner sidecar and are served at `/v1/chat/sessions`. The chat CLI is gone.
   *(done 2026-09-21)*
7. Tailnet hosting with Tailscale identity; homelab capabilities in the same
   catalog.

Fixture execution, draft publication and owned-project changes stay on their
CLIs until the read-only surface is done; they carry real effects.

## Capability inputs

| Capability | Input | Needs |
| --- | --- | --- |
| `repository.brief` | configured repository, time window | `gh` |
| `issue.readiness` | configured repository, issue number | `gh` |
| `code.location` | a completed ready `issue.readiness` job | checkout configured for that repository |
| `investigation.packet` | configured repository, issue number | checkout |
| `change.proposal` | a completed `investigation.packet` job, query for features | checkout |
| `change.approve` | a completed `change.proposal` job, reason, optional file override | `implementation` config for the repository |
| `change.implement` | a completed `change.approve` job | pinned runtime, sandbox (podman), provider |
| `change.publish` | a verified `change.implement` job, reason | publication config with the draft-PR target |

A repository's `implementation` block names the repository profile, the pinned
runtime and the publication configuration files. The approval records the
task the person authorized: title, request text built from the proposal,
the files the agents may edit (cited sources within the profile's allowed
paths, or an explicit override), and source context. Implementation checks
the profile hash against the approval before any model call and fails with
a reason if the environment changed.

The host resolves the checkout's current `HEAD` as the pinned commit at job time
and records it in the result.

## Recipes

A recipe is operator content, not code. It can only name capabilities the
invoker is already granted, and each step is validated by that capability's
own input schema when it runs.

```json
{
  "schemaVersion": 1,
  "id": "investigate-issue",
  "title": "Investigate an issue",
  "steps": [
    { "id": "readiness", "capability": "issue.readiness",
      "input": { "repository": { "$param": "repository" }, "issue": { "$param": "issue" } } },
    { "id": "locate", "capability": "code.location",
      "input": { "readinessJobId": { "$job": "readiness" } } }
  ],
  "layout": { "readiness": { "x": 80, "y": 80 }, "locate": { "x": 420, "y": 80 } }
}
```

- A step input field is a literal, `{"$param": name}`, `{"$job": stepId}` (that
  step's job ID) or `{"$result": [stepId, "dotted.path"]}` (a value from its
  result). Bindings may only point at earlier steps.
- Parameters are inferred from what they bind to, so the run form for
  `recipe.<id>` shows the same dropdowns and limits as the underlying
  capability. Explicit `params` override the inference.
- The host exposes a recipe as capability `recipe.<id>` to any invoker granted
  every step's capability. Submitting it creates a parent job; the orchestrator
  submits each child with `parentJobId` set and an idempotency key derived from
  the parent's, waits for it, then resolves the next step's bindings. A failed
  step fails the recipe unless `continueOnFailure` is set. Cancelling the
  parent cancels the running child. Restart marks an unfinished recipe
  interrupted and never replays it.
- Recipes load from files named in the host config (`recipes`) and from
  `<state>/recipes/*.json`, where the web app saves them. Nested recipes are
  not supported.

## Rules kept from the proving phase

Browser input picks configured targets by ID and never paths, credentials,
commands, providers or models. Every job persists before it runs and after it
finishes; interrupted jobs are never replayed automatically. Completed means a
validated artifact exists; the artifact's own partial or failed status stays
visible.
