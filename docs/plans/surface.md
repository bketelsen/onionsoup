# Plan: an onionsoup surface

Status: merged to `main` on 2026-09-23 and running as `onionsoup-surface.service` on http://127.0.0.1:4747. It
replaced OpenChamber, which the person retired the same day. Remaining items are features, not blockers.

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
- [x] Re-order owners in the rail (drag with pointer events), saved by the surface server so it holds across browsers

### 3. Owner and work views
- [x] Inbox with inline decisions and their context (plan, diff stat, verification, failed logs)
- [x] Owner page: identity, what waits, open and recent work, activity timeline (asks, CI triage, notes), notebook
- [x] Work item page: proposal, plan, hires, verification, reviews, PR link

### 4. Chat
- [x] Study OpenChamber's chat: ChatMessage, MessageBody, message/parts, toolRenderers, PermissionCard,
      QuestionCard, MarkdownRenderer; list what to port and what to simplify
- [x] Message list: user and assistant turns, streaming text parts, markdown (marked + DOMPurify)
- [x] Code highlighting (shiki, as OpenChamber) in markdown code blocks, loaded on demand
- [x] A real diff view for edits (edit, apply_patch, write); highlighted bash commands in tool rows
- [x] Reasoning parts (collapsed), tool parts (one line, expandable output; renderers for bash, read, edit/write
      diffs, grep/glob, onionsoup tools)
- [x] Permission cards (once / always / reject) and question cards inline (verified with a real prompt)
- [x] Auto-accept per chat (OpenChamber's shield toggle): kept by the server, so it answers prompts even with no
      browser open; sub-chats inherit it; switching it on answers prompts already waiting
- [x] Composer: textarea, send, stop; the owner's agent is fixed per chat
- [x] Threads per owner: list, new; live across reconnects (reload on reconnect)
- [x] Rename threads (double-click in the list)
- [x] Owner-to-owner asks and hires shown in the timeline (answers expand, work items link), engine sessions folded away

### 5. Integration
- [x] Run it: `npm run surface`; `deploy/onionsoup-surface.service`
- [x] Docs: README, docs/extending.md (running the surface), design doc section
- [x] Decided: keep `sync-openchamber` and the Owner's Desk while OpenChamber is still in use; they cost nothing when it is not. Revisit after a few weeks of daily use of the surface.

### 6. Polish (after daily use)
- [x] Unread and running indicators; notifications for new inbox items
- [x] Keyboard navigation (Alt+↑/↓ owners, Alt+I inbox, / message)
- [x] Very long chats open on their latest 30 turns; long outputs and diffs scroll in capped boxes

### 7. Next (from daily use)
- [x] Merge to `main` and install `deploy/onionsoup-surface.service` (2026-09-23; OpenChamber retired)
- [ ] UI tests for the chat's event handling (useChat) and the diff parser
- [ ] Decisions on the work item page itself (approve, send back, publish) instead of only from the inbox

## Notes for whoever resumes

- The chat's visual spec extracted from OpenChamber (class names, CSS, per-tool icons and titles) was saved at the
  session scratchpad as openchamber-chat-spec.md; the source of truth is `~/projects/openchamber/packages/ui/src/components/chat`.

- Run it with its own opencode (the default: no OPENCODE_URL). Attaching to OpenChamber's opencode breaks whenever
  OpenChamber restarts, because its opencode comes back on a new port with a new password; the surface then shows
  a banner instead of chats. Sessions live in opencode's shared store, so both UIs see the same chats either way.
  What each server knows only in memory stays with it: a chat's live stream and its pending permissions show where
  that chat is running.
- Session lists include engine sessions that ran in the same directory (hires titled `<owner>: …` or `w-…: …`);
  the UI should group them apart from the person's chats.

- The opencode server's HTTP API: `/event` (SSE), sessions and messages, `prompt_async`, `/permission` and
  `/question` replies. The typed client is `@opencode-ai/sdk/v2` (already a dependency of `@onionsoup/owners`).
- OpenChamber's opencode runs with `OPENCODE_SERVER_PASSWORD`; the surface reads it from the environment, never logs
  it, never sends it to the browser.
- Decisions go through the same engine functions the CLI uses, lock-free, so the running daemon picks them up.
- Leto is hardening the sandbox (w-20260923-7d949a): hire sessions may stop living in the shared opencode store, so
  the surface links hires through work items rather than reading their sessions.
