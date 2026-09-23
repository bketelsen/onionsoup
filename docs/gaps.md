# Gaps

What onionsoup cannot do yet, most important first. Owners (Leto in particular) should shrink this list.

## Owners and their authority

- **Desk changes need a first real run.** `onionsoup_propose_changes` (verify → cross-family review → commit →
  push → PR → merge under a `merge` grant → publish if the owner is a site source) is built, and Bellonda holds a
  merge grant for her wiki, but it has not yet run end to end. Her `minideb` page and `selfie` correction are
  waiting on her desk: ask her to propose them.
- **Leto cannot deploy onionsoup yet.** He can change the engine on his desk and open reviewed PRs, and create
  owners in `~/.config/onionsoup` with approval, but after a merge nothing pulls the running checkout and
  restarts the daemon and OpenChamber's opencode. A `deploy` action (pull, `npm ci`, verify, restart, roll back
  on failure) behind a grant or approval would close this.
- **Autonomous runs cannot use owner MCP tools.** Declared `mcp:` servers are available in chats only; duties and
  hires in the sandbox do not get them (the NAS owner's snapshot and updates use host code instead).
- **No budgets.** Per-owner cost caps and wake-rate limits are designed but not enforced, and cost is only tracked
  for providers that report it (Copilot); ChatGPT OAuth reports $0.
- **Owner-to-owner messages are limited** to questions and three request kinds. There is no general
  `request.work` ("please change your domain") or escalation when an owner declines.

## Surfaces

- **The Desk polls** every 20 seconds and has no push. It cannot open itself, and a job cited in chat cannot link
  to its page.
- **Notifications:** nothing tells the person that something waits on them except the Desk badge.
- **Personas are thin in the UI:** OpenChamber shows the agent name and an automatic color; the Desk shows initials.
  No portraits.
- **Plugin changes need an opencode restart** in OpenChamber, and the daemon needs a restart for engine changes.

## Runtime

- **Attention items are write-only:** raised to the journal and Desk, with no acknowledge or resolve.
- **App updates cannot roll back:** truenas-mcp exposes no rollback, so a failed update is raised for the person.
- **Held app updates are only re-read on a new version** or after 7 days; a person cannot say "this app's
  changelog lives in its commit log" except through the owner's notebook.
- **Charters are drafts written by Claude** for Bellonda, Miles Teg, Moneo and Leto. The person should rewrite
  them; they steer everything the owners do.
- **Duties have no event triggers** yet (`on:` is declared but unused); everything is scheduled or chat-driven.
