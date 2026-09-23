# Gaps

What onionsoup cannot do yet, most important first. Owners (Leto in particular) should shrink this list.

## Owners and their authority

- **Desk changes need a first real run.** `onionsoup_propose_changes` (verify → cross-family review → commit →
  push → PR → merge under a `merge` grant → publish if the owner is a site source) is built, and Bellonda holds a
  merge grant for her wiki, but it has not yet run end to end. Her `minideb` page and `selfie` correction are
  waiting on her desk: ask her to propose them.
- **Leto ships the daemon, not OpenChamber.** `onionsoup_ship` fast-forwards the running checkout, verifies it,
  restarts the daemon with a health check and rolls back on failure, but OpenChamber's opencode (which loads the
  plugin) still needs a person to restart it.
- **snosi builds run only in CI.** mkosi needs root, so Murbella verifies with snosi's static checks and relies on
  GitHub Actions for builds (CI failures wake her). Local builds would need a privileged build VM on minideb,
  requested from Miles Teg like the smoke-test instances.
- **Odrade observes but cannot assign.** She watches the Frostyard org and knows its owners, but there is no
  "owner of owners" mechanism yet: she cannot hand work to Murbella or propose new owners except through the person.
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
- **Hires can loop until their time limit.** An implementer sometimes degenerates (hundreds of trivial commands such
  as `echo`), and nothing notices before the 20-minute limit ends the hire. The owner now hears about the failure,
  but a progress watchdog (stop a hire whose recent tool calls change nothing) or a retry with the other model family
  would save the twenty minutes. Work opened by duties (not from a chat) is journaled but has no chat to be told in.
