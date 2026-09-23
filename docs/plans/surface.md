# Plan: an onionsoup surface

Status: in progress on branch `surface`, in the worktree `~/projects/onionsoup-surface` (kept apart from the running
checkout `~/projects/onionsoup`, which Leto ships into). Merge to `main` when the surface can replace OpenChamber for
daily use.

## Why

The opencode plugin and owner agents work well; OpenChamber as the surface does not fit. With many owners, chats are
hard to follow. The Owner's Desk is limited by what extensions can do (a panel plus a service that shells out to the
CLI). onionsoup needs a surface organized around owners: who they are, what waits on the person, and what each is
doing, with chats that read as well as OpenChamber's.

## Shape

- `packages/surface`: a Node server (TypeScript, built like other packages) that
  - attaches to an `opencode serve` running the onionsoup plugin (by URL and password), or starts one;
  - imports `@onionsoup/owners` directly (desk state, status, decisions: no CLI round trips);
  - relays opencode's event stream to the browser, and serves the built UI.
- `packages/surface/web`: the UI, React 19 + Vite + Tailwind 4 (the same stack as OpenChamber, so its design tokens and
  chat components can be ported). It has its own tsconfig and build; the root typecheck excludes it.
- The browser talks only to the surface server. The opencode password never reaches the browser.
- Borrowed from OpenChamber (MIT, `~/projects/openchamber`): design tokens and typography, and the chat message,
  tool, permission and question rendering. Borrowed files keep a header naming their source, and
  `packages/surface/web/NOTICE` carries OpenChamber's MIT license.

Deliberately left out: file tree, terminal, model picker, attachments, undo/revert, sharing, multi-project
management, mobile.

## Todo

Tick items as they land, with the commit.

### 0. Setup
- [x] Worktree `~/projects/onionsoup-surface` on branch `surface`
- [x] This plan
- [x] `packages/surface` skeleton; dependencies; root scripts (`surface`, `surface:build`, `surface:typecheck`),
      with the web build and typecheck part of `npm run verify`
- [x] `@onionsoup/owners` exports what the surface needs (deskState, statusText, itemText, decision functions,
      Runtime paths)

### 1. Server
- [x] Config: port (default 4747), opencode URL and password (env), or start `opencode serve` itself
- [x] opencode client (SDK v2) and an SSE relay: `/api/events` forwards opencode events plus onionsoup events
      (ledger and request changes, polled from state)
- [x] `/api/state`: owners (persona, domain summary, waiting and running counts) and the inbox: everything waiting on the person across owners (plans, pushes, publishes, create/delete,
      pending opencode permissions and questions)
- [x] `/api/owners/:id`: desk state (work, recent, activity, notes, notebook registers)
- [x] `/api/items/:id`: one work item in full
- [x] Decisions: approve/revise/reject plan, approve push, publish, approve/deny create and delete, retract a note
- [x] Sessions: list per owner (its chat directory), create, messages, prompt (async), abort
- [x] Permission and question replies
- [x] Serve `web/dist` (dev: Vite proxies `/api` to the server)
- [x] Tests: endpoint tests against the fixture runtime and a fake opencode client

### 2. UI shell
- [x] Theme: OpenChamber tokens (design-system.css, typography.css), light and dark
- [x] Layout: owner rail (persona, icon, badges) | main pane | inbox drawer; hash routing
- [x] Live updates from `/api/events` with reconnect

### 3. Owner and work views
- [x] Inbox with inline decisions and their context (plan, diff stat, verification, failed logs)
- [x] Owner page: identity, what waits, open and recent work, activity timeline (asks, CI triage, notes), notebook
- [x] Work item page: proposal, plan, hires, verification, reviews, PR link

### 4. Chat
- [ ] Study OpenChamber's chat: ChatMessage, MessageBody, message/parts, toolRenderers, PermissionCard,
      QuestionCard, MarkdownRenderer; list what to port and what to simplify
- [ ] Message list: user and assistant turns, streaming text parts, markdown (marked + DOMPurify), code highlighting
- [ ] Reasoning parts (collapsed), tool parts (one line, expandable output; renderers for bash, read, edit/write
      diffs, grep/glob, onionsoup tools)
- [ ] Permission cards (once / always / reject) and question cards inline
- [ ] Composer: textarea, send, stop; the owner's agent is fixed per chat
- [ ] Threads per owner: list, new, rename; stay live across reconnects
- [ ] Owner-to-owner asks and hires shown as links in the timeline, not as loose sessions

### 5. Integration
- [ ] Run it: `npm run surface`; a systemd user unit in `deploy/`
- [ ] Docs: README, docs/extending.md (running the surface), design doc section
- [ ] Decide what happens to `sync-openchamber` and the Owner's Desk extension (keep until the surface replaces them)

### 6. Polish (after daily use)
- [ ] Unread and running indicators; notifications for new inbox items
- [ ] Keyboard navigation
- [ ] Long outputs, big diffs, very long chats (virtualize)

## Notes for whoever resumes

- Run against the live system without disturbing it: `SURFACE_PORT=4748 OPENCODE_URL=http://127.0.0.1:<port>
  OPENCODE_SERVER_PASSWORD=… npm run surface` attaches to OpenChamber's opencode (find its port with
  `ps -eo args | grep "opencode serve"`; the password is in that process's environment, never print it).
- Session lists include engine sessions that ran in the same directory (hires titled `<owner>: …` or `w-…: …`);
  the UI should group them apart from the person's chats.

- The opencode server's HTTP API: `/event` (SSE), sessions and messages, `prompt_async`, `/permission` and
  `/question` replies. The typed client is `@opencode-ai/sdk/v2` (already a dependency of `@onionsoup/owners`).
- OpenChamber's opencode runs with `OPENCODE_SERVER_PASSWORD`; the surface reads it from the environment, never logs
  it, never sends it to the browser.
- Decisions go through the same engine functions the CLI uses, lock-free, so the running daemon picks them up.
- Leto is hardening the sandbox (w-20260923-7d949a): hire sessions may stop living in the shared opencode store, so
  the surface links hires through work items rather than reading their sessions.
