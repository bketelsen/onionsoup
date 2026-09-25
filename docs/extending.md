# Creating your own owners and tools

Onionsoup is the engine; your owners are configuration in your own directory (`~/.config/onionsoup` by
default, or `ONIONSOUP_CONFIG`). Nothing about your owners lives in this repository, and adding an owner or a
tool needs no onionsoup code.

## Start

```bash
git clone https://github.com/bketelsen/onionsoup && cd onionsoup && npm ci
npm run owners -- init            # creates ~/.config/onionsoup from examples/starter, as its own Git repo
```

Then register the plugin with opencode, so your owners become agents you can chat with
(`~/.config/opencode/opencode.json`):

```json
{ "plugin": ["file:///path/to/onionsoup/packages/owners/src/plugin.ts"] }
```

Requirements: Node 24, opencode (logged in to the providers your owners use), `bwrap` and `systemd-run`
(the sandbox), Git and `gh`.

## Create an owner

1. Copy `owners/example.yaml` to `owners/<id>.yaml` and edit it: persona, domain, model, conversation rules,
   duties. Write `charters/<id>.md` yourself: it steers everything the owner does.
2. The daemon re-reads your configuration every minute and starts the owner's duties; its desk is made when its
   chat first opens.
3. Restart the surface (`systemctl --user restart onionsoup-surface`, or the opencode you use) so the plugin picks up
   the new agent.
4. Talk to it. Run its duties with `npm run owners -- wake <id> <duty>`, or leave it to the daemon.

A repository owner needs a persona to change its repository: it plans with you in chat, runs approved plans in
their own sessions and proposes its desk changes. Without one it only observes.

### Pick the models

`freelancers/*.yaml` name the models, never the process:

```yaml
# freelancers/implementer.yaml: every owner's implementer subagent, and conflict resolution in rebases
craft: implementation
models: [github-copilot/claude-sonnet-5, openai/gpt-5.6-sol]
# freelancers/reviewer.yaml: each owner's reviewer subagent and the required review of proposed changes
craft: review
models: [openai/gpt-5.6-sol, github-copilot/claude-sonnet-5]
```

An owner's reviewer is the first `review` model outside the family of the owner's own `model`, as `families.yaml`
decides, so list models from at least two families. Files from older configurations (`craft: planning`,
`workflows/`, `rubrics/`, and `workflow:` lines on owners) are ignored and can be deleted. The process an owner
follows lives in the skills in `packages/owners/skills`; changing it is engine code.

### Own several repositories together

Related repositories can share one owner. Each repository keeps its own verification; work items, proposals and
desk changes name the repository they are in, and the desk is a folder with one worktree per repository.

```yaml
domain:
  kind: repository-group
  name: frostyard/image-platform
  repositories:
    - { name: frostyard/lab, remote: git@github.com:frostyard/lab.git, baseBranch: main, verify: [[make, check]] }
    - { name: frostyard/testsuite, remote: git@github.com:frostyard/testsuite.git, baseBranch: main, verify: [[go, test, ./...]] }
```

A group owner cannot be a site source or ship (both need exactly one repository).

## Give an owner tools

Any MCP server can be an owner's tool, visible to that owner alone:

```yaml
mcp:
  github:
    command: [github-mcp-server, stdio]
    envFile: ~/.config/onionsoup/secrets/github.env   # KEY=VALUE lines; values are never logged
    rules:
      "*": allow                   # the server's tools, by name
      create_pull_request: ask     # the person approves in the chat
      delete_repository: deny      # hidden from the owner entirely
```

Everything else follows the owner's `conversation:` rules: `allow`, `ask` (approve in the chat) or `deny`.

`onionsoup_friction({ summary, expected, actual, evidence? })` captures unexpected engine behavior from an
owner chat. The host adds the originating session, running engine checkout commit, observed model and bounded
failed-tool context; it never stores raw tool arguments. Repeated safe error shapes share one report, while a
missing failure event is marked provisional. Reports appear in the surface's Friction view; triage and issue
publication are not yet available. `FRICTION_LIMITS` in `packages/owners/src/friction.ts` bounds prose, errors,
session history, records and listings.

## Give an owner authority

Authority comes only from your configuration:

- `domain.incus.remotes[].allow` decides where instances may be created and deleted.
- `grants:` are standing approvals: `{ to: <owner>, action: publish-site | update-app | merge | ship | approve-plans, target: <name or "*"> }`.
  Without a grant, the runtime asks you.
- `reportsTo: <owner>` puts an owner under a manager (see [Managers and initiatives](#managers-and-initiatives)).
- `manages: { owners: [<glob>, ...] }` makes an owner a steward: with its `onionsoup_owners` tool it creates,
  changes and retires owners whose domain (repository or org name) matches, with your approval for each write. It
  can never write `grants`, `deploy`, `incus`, `mcp` or `manages`, nor change itself.
- `deploy: { checkout, services }` says where a repository owner's code runs; with it the owner can ship
  (fast-forward, verify, restart with a health check and rollback).
- Destructive actions, plan approval and creates/deletes always stop for you unless a grant says otherwise.

## Managers and initiatives

A manager is any owner others report to. Declare the line on each report, and give the report a `maintain-prs`
duty so its merges are recorded (an initiative is complete only when its work has merged):

```yaml
# owners/murbella.yaml
id: murbella
reportsTo: odrade
duties:
  - { id: prs, kind: maintain-prs, every: 15m, instructions: "Keep published PRs mergeable." }
grants:
  # Optional: Odrade approves Murbella's plans for Odrade's initiatives; every use is journaled.
  - { to: odrade, action: approve-plans, target: frostyard/snosi }
```

The manager then plans cross-repository change in chat with `onionsoup_initiative`: a title, goal, rationale and
assignments such as `{ id: core-doc, to: taraza, proposal: {...} }` and `{ id: snosi, to: murbella, after: [core-doc],
proposal: {...} }`. You approve the breakdown once (the surface inbox, or `npm run owners -- approve-initiative <id>`;
`revise-initiative <id> --note` and `cancel-initiative <id> --reason` send it back or stop it), and `owners
initiatives` / `owners initiative <id>` read them. The daemon dispatches each assignment when its dependencies have
merged; the report accepts it automatically, plans it in a session of its own, and can push back with
`onionsoup_raise`. With an `approve-plans` grant the manager is woken in the initiative's chat to approve or send back
each plan (`onionsoup_steer`); without one, every plan waits for you in the inbox. `INITIATIVE_LIMITS`
(`maxAssignments`, `maxOpenPerManager`) and `SUPERVISION_LIMITS.revisionsPerItem` bound the work. A steward may put owners
in its scope under itself, but only you set any other reporting line or grant.

## Run it always on

```bash
cp deploy/onionsoup-owners.service ~/.config/systemd/user/     # adjust WorkingDirectory and PATH
systemctl --user daemon-reload && systemctl --user enable --now onionsoup-owners
```

The surface (`npm run surface:build && npm run surface`, or `deploy/onionsoup-surface.service`) serves your owners,
their chats and one inbox of everything waiting on you at http://127.0.0.1:4747. It starts its own opencode, or
attaches to one given `OPENCODE_URL`.

## Calendar briefings

An elapsed duty such as `every: 1d` is not a 9 AM schedule. For a daily chat briefing, install the standalone
runner and systemd user units. This does not require restarting the daemon or surface. OpenChamber's stored
scheduled tasks do not run after its server stops; copy the intended prompt and destination explicitly.

Create `~/.config/onionsoup/briefings/<name>.json` with your owner's existing chat ID (from the surface's
`GET /api/owners/<owner>/sessions`), an absolute state directory, and the instruction you want repeated:

```json
{
  "id": "daily-briefing",
  "owner": "your-owner",
  "sessionID": "your-existing-session-id",
  "surfaceUrl": "http://127.0.0.1:4747",
  "stateDirectory": "/absolute/path/to/onionsoup/state/briefings/daily-briefing",
  "timezone": "America/New_York",
  "localTime": "09:00",
  "prompt": "Prepare today's briefing in this chat. State evidence dates and decisions needed. Observe only."
}
```

The timer's `OnCalendar` must match `timezone` and `localTime` in the configuration. Its default is 9 AM
America/New_York, including daylight-saving changes. `Persistent=true` catches up once after downtime; it does
not replay every missed day. The runner uses the most recent scheduled local date, so a retry after midnight
does not produce tomorrow's briefing early. Keep the user manager running while logged out (user lingering)
if that is required on your host.

```bash
install -Dm644 scripts/scheduled-briefing.mjs ~/.local/share/onionsoup/tools/scheduled-briefing.mjs
mkdir -p ~/.local/share/onionsoup/tools/node_modules
cp -a node_modules/zod ~/.local/share/onionsoup/tools/node_modules/
cp deploy/onionsoup-briefing@.service deploy/onionsoup-briefing@.timer ~/.config/systemd/user/
systemctl --user daemon-reload
node ~/.local/share/onionsoup/tools/scheduled-briefing.mjs --config ~/.config/onionsoup/briefings/<name>.json --run-key smoke-test
systemctl --user enable --now onionsoup-briefing@<name>.timer
systemctl --user list-timers 'onionsoup-briefing*'
```

The smoke test sends a real prompt and waits for the owner's completed answer. Its separate key does not consume
the next scheduled date. The configured chat must remain available. Conversation permissions still apply;
a briefing that asks for permission may need a person to finish it. A reported busy chat defers submission to
the next five-minute retry. This is a best-effort check: the current surface hides status-query failures and
does not offer an atomic idle-and-submit operation. The runner records each run atomically under `stateDirectory`.
A successful POST alone is not completion: the runner
requires a completed, non-error assistant answer linked to its own prompt. The prompt marker reconciles retries
against the persisted transcript. If submission is uncertain and the marker cannot be found, the runner fails
with a reason instead of submitting a possible duplicate. Inspect the transcript before resolving that record.

Records live in `stateDirectory/<id>/<runKey>.json`; `<runKey>.intent.json` is the durable submission claim.
For `submission_ambiguous`, stop the service and inspect the destination chat first. If the marked prompt exists,
preserve both records and retry monitoring. Only after establishing that no prompt was accepted should you
archive both files outside that directory and restart the service. A crash immediately before the POST also
requires this check. HTTP rejections stay conservative because a downstream error alone does not prove that no
effect occurred. For `run_state_invalid`, stop the service, preserve the corrupt file for inspection, and restore
it from a known-good copy or reconstruct it from the transcript; never clear an intent merely to silence an error.

Monitor with `journalctl --user -u onionsoup-briefing@<name>.service` and the run records. Failed or incomplete
runs retry every five minutes; existing prompts are monitored without sending another prompt. These failures
are not yet shown in the onionsoup inbox. Disable with
`systemctl --user disable --now onionsoup-briefing@<name>.timer` and stop the corresponding service to stop retries.
Stopping the runner does not abort an owner reply already in progress. Update the installed script when upgrading;
it and its Zod dependency are deliberately separate from the active checkout.
The default completion timeout is 20 minutes; keep overrides below the unit's 30-minute `TimeoutStartSec`, or
adjust that limit too. A new scheduled date supersedes an unfinished previous date; historical missed briefs
are not replayed. Use a fresh `--run-key` for each new smoke test; reusing a completed key intentionally sends nothing.

## Notebook maintenance

Notebook maintenance runs automatically for every owner. Override its defaults in an owner's declaration:

```yaml
memory:
  enabled: true
  everyMs: 3600000       # at most hourly when unread journal entries exist
  retryMs: 300000        # retry failed runs after five minutes
  batchDelayMs: 60000    # continue automatic backlogs after one minute
  minEntries: 1
  maxEntries: 100        # one bounded batch per pass
  maxChars: 24000
```

Use **Update notebook** in the surface notebook or `owners distill <owner>` to queue a pass even when automatic
maintenance is disabled. The running daemon (or `owners tick`) consumes the request. New requests arriving during
a hire remain queued; errors appear in the notebook controls. Increase `maxChars` if an individual journal entry
exceeds the batch limit. Automatic maintenance waits while that owner has active work or a duty. Manual requests
remain queued until their backlog drains; automatic backlogs use `batchDelayMs` between batches. Housekeeping
entries (`wake`, `app-updates`, `maintain-prs`) advance the cursor without a model hire. Interrupted hires appear
as retryable failures. Journal entries are retained on size/parse errors so decisions cannot silently disappear.

## Recent chat context and owner exchanges

An owner's declaration can override the recent-context defaults independently of notebook distillation:

```yaml
chatContext:
  ageHours: 48
  maxEntries: 32
  maxChars: 8000
  entryChars: 2000
  scanBytes: 131072       # total recent journal bytes read per context refresh
  noticeChars: 12000     # displayed exchange excerpt; full text stays on disk
  noticeSessions: 30     # most recently updated nonchild sessions inspected
```

Every chat system transform reads recent activity again. Owner answers also read recent person decisions,
including undistilled choices. Limits retain the newest eligible records; retractions found in the scanned window
cancel matching decisions. Increase the age or byte limit when a busy journal pushes relevant context out.

The plugin checks the durable exchange queue every 15 seconds. It selects the answering owner's latest person
message among the inspected sessions, ignoring synthetic messages, runtime notices and other agents. Delivery
uses `noReply`, so it adds transcript evidence without hiring an owner or watcher. Unreadable candidate sessions (including structured-output hires) are logged and skipped. Busy chats, failed
session listings and missing person chats leave the notice queued. Exchanges survive plugin restarts; accepted posts use a stable
message ID to avoid duplicates after acknowledgement loss. Full records are retained under
`$ONIONSOUP_HOME/notices/exchanges/pending` or `delivered`, with absolute paths and their ID cited in the transcript. Owners without a persona do not queue new chat notices;
legacy notices for personless or retired owners move to `undeliverable` with a reason. Discovery reloads
configuration before treating an unknown owner as retired, so an older plugin cannot discard a new owner’s notice. If the owner's
person chat is older than the configured session search window, raise `noticeSessions` or speak in that chat.
Restart the surface after installing plugin changes.

## What needs engine code

New domain kinds (how an owner observes and changes something, like `git-repository`, `incus`, `truenas`, `github-org`), new
request kinds, and new duty kinds are engine code in `packages/owners`. See [gaps.md](gaps.md) for what is
missing, and the [design](design/owners.md) for how the pieces fit.

## Work lifecycle changes

Work item readers should use the public `WorkItem` schema. Use `Ledger.update(id, mutate)` for partial changes
from a person decision, a background task, or a publication checkpoint: it reloads the record under a kernel
lock shared by all runtime processes. Keep the mutation synchronous and perform external effects outside the
lock. Learning records, publication state, and human notes must not be replaced from an old snapshot.

What host code still advances is a lookup table in `packages/owners/src/work-recovery.ts`: each workflow
(`owner-change`, `desk-publication`, `rebase`) names its `advance` step and when it is runnable, and `FIRST_STEP` says
where stopped work continues. A new kind of host-run work adds an entry there; the dispatcher does not change. It
should record `resumeStatus` before claiming an active stage and clear `activeRunner` when it finishes. Person
decisions use `approvePlan`, `revisePlan`, `resumeItem`, `retryItem` and `cancelItem`; cancellation of active work is
refused. Desk publication (also used by approved plans and CI repairs) keeps its persisted stage to reconcile
retries against the local commit and existing GitHub PR before repeating effects.

## Delegation, attention and recovery

An owner can call `onionsoup_request_work` with a declared receiver, title, goal, rationale, acceptance criteria,
size, and (for repository groups) repository. Receivers must be able to change their repository (a repository owner
with a persona); others are refused before a request is opened. Accepting creates a work item the receiver plans in a
session of its own, and its plan waits for your approval in the inbox (or a manager's `approve-plans` grant).
The request keeps its linked work id and outcome; declines, failed work and closed unmerged PRs raise attention for both owners.

Use `onionsoup_attention` to list an owner's attention, acknowledge it, resolve it with an outcome, or reopen it.
The surface inbox also offers acknowledgement and resolution. All decisions keep the original journal entry and record
who acted and why. Recovery controls for interrupted resource requests distinguish read-only outcome checks from an
explicit retry after inspection; a retry or stop requires a reason. Incus instances created before request tagging cannot
be automatically adopted from their names alone.

Attention's first import uses `ATTENTION_LIMITS.initialHistoryDays` (default 7); older history stays in the notebook
without flooding the inbox. Its persisted cursor and cache read only appended journal bytes, up to
`ATTENTION_LIMITS.scanBytesPerFile` per file per scan. Malformed lines are skipped with a location-only diagnostic;
an incomplete current-day tail is retried when more bytes arrive. Past completed daily journals are immutable inputs.
Request model-only retries use `REQUEST_LIMITS.decisionAttempts`, `retryBaseMs` and `retryMaxMs`. Ambiguous read-only checks wait `REQUEST_LIMITS.reconcileMs` (default five minutes)
between attempts, so the same old request does not occupy an owner on every tick. Reconciliation of a
publication requires both recorded completion of the restart/serving check and a matching served `index.html` digest;
it does not prove a full static asset tree from index content alone.
