# Gaps

What onionsoup cannot do yet, most important first. Owners (Leto in particular) should shrink this list.

## Owners and their authority

- **Desk changes need a first real run.** `onionsoup_propose_changes` (verify → cross-family review → commit →
  push → PR → merge under a `merge` grant → publish if the owner is a site source) is built, and Bellonda holds a
  merge grant for her wiki, but it has not yet run end to end. Her `minideb` page and `selfie` correction are
  waiting on her desk: ask her to propose them.
- **Shipping and the surface.** `onionsoup_ship` restarts the services in the owner's `deploy` section with a health
  check. The surface's opencode loads the plugin, so plugin changes need `onionsoup-surface` restarted too; listing
  it in `deploy.services` makes ship do it, at the cost of cutting off any reply in progress.
- **snosi builds run only in CI.** mkosi needs root, so Murbella verifies with snosi's static checks and relies on
  GitHub Actions for builds (CI failures wake her). Local builds would need a privileged build VM on minideb,
  requested from Miles Teg like the smoke-test instances.
- **Autonomous runs cannot use owner MCP tools.** Declared `mcp:` servers are available in chats only; duties and
  hires in the sandbox do not get them (the NAS owner's snapshot and updates use host code instead).
- **No budgets.** Per-owner cost caps and wake-rate limits are designed but not enforced, and cost is only tracked
  for providers that report it (Copilot); ChatGPT OAuth reports $0.

## Surfaces

- **The Desk polls** every 20 seconds and has no push. It cannot open itself, and a job cited in chat cannot link
  to its page.
- **Personas are thin in the UI:** the surface shows a name and an icon. No portraits.
- **Plugin changes need the surface restarted** (its opencode loads the plugin), and the daemon needs a restart for
  engine changes.

## Runtime

- **Sandbox: provider credentials are still readable.** Masking the host opencode config/state closed the plugin
  path (`~/.config/opencode`), but `~/.local/share/opencode/auth.json` stays writable in every sandbox because
  hires must keep authenticating; a credential proxy that hides the real tokens from the sandboxed process is the
  next step.
- **Sandbox: no network isolation.** After the credential proxy, outbound network access from a sandboxed process
  is still unrestricted; an allowlist or a proxy is the follow-up.
- **App updates cannot roll back:** truenas-mcp exposes no rollback, so a failed update is raised for the person.
- **Held app updates are only re-read on a new version** or after 7 days; a person cannot say "this app's
  changelog lives in its commit log" except through the owner's notebook.
- **Charters are drafts written by Claude** for Bellonda, Miles Teg, Moneo and Leto. The person should rewrite
  them; they steer everything the owners do.
- **Duties have no event triggers** yet (`on:` is declared but unused); everything is scheduled or chat-driven.
- **Hires can loop until their time limit.** An implementer sometimes degenerates (hundreds of trivial commands such
  as `echo`), and nothing notices before the 20-minute limit ends the hire. The owner now hears about the failure,
  but a progress watchdog (stop a hire whose recent tool calls change nothing) or a retry with the other model family
  would save the twenty minutes. Work opened by duties (not from a chat) is journaled but has no chat to be told in.

## Workarounds to revisit

- **opencode cannot return structured-output sessions (seen in 1.18.32).** Once a prompt carries a `json_schema`
  format, listing that session's messages over HTTP fails with `BadRequest: Expected OutputFormatJsonSchema`.
  Every hire asks for structured output, so two things work around it:
  - `packages/owners/src/opencode.ts` prompts hires synchronously and takes the deliverable from the prompt's own
    reply instead of reading the session back.
  - `packages/surface/src/hire-store.ts` reads hire sessions for the work item activity rail straight from
    opencode's SQLite store (read-only), which ties the surface to opencode's internal tables.

  To check a new opencode: run any hire, then `GET /session/<id>/message` on the server that ran it (or, in the
  surface, point the item-messages route back at `state.opencode.messages`). If it answers, drop both workarounds:
  prompt hires asynchronously and read sessions through the API.
- **An opencode server does not see sessions other servers create.** It lists a folder's sessions from what it has
  loaded, and hires are created by the daemon's own servers, so the surface's opencode never listed a hire that
  started after the surface did. The activity rail finds an item's hire sessions by title in opencode's store
  (`readSessionsTitled` in `packages/surface/src/hire-store.ts`) instead.

