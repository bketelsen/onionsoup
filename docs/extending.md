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

### Add a model provider

Any OpenAI-compatible endpoint (a local model server, a hosted gateway) can serve owners, the operator and every
hire. Declare it once in `providers.yaml` at the top of your config directory; without the file there are none.

```yaml
# providers.yaml
halogen:                              # provider id: models are halogen/<model id>
  name: Halogen (selfie)              # shown in opencode (default: the id)
  baseURL: http://10.0.1.200:8731/v1
  models:
    halogen-qwen3.8-flash-next:
      contextTokens: 78000            # optional: the context window; outputTokens (default 8192) needs it
  apiKeyFile: secrets/halogen.key     # optional: a file under secrets/, read at load and never logged
```

The plugin adds it to the surface opencode's providers (your own opencode providers stay; one with the same id is
replaced), and every sandboxed hire gets the same provider in its own opencode config, since the sandbox hides
`~/.config/opencode`. Ids of opencode's built-in providers (`openai`, `anthropic`, `github-copilot`, `google`, …) are
refused. Every hire asks for its deliverable as one JSON object in the reply text and validates it, so a model needs
no forced tool call.

Give its models a family, so cross-family review can pick them. A new family widens the choice: an owner on a
Claude model can now be reviewed by Qwen, and the other way round.

```yaml
# families.yaml
families:
  - family: qwen
    match: ["halogen/*"]
```

Then use its models like any other: `model: halogen/halogen-qwen3.8-flash-next` on an owner or the operator, or in
a freelancer's `models:` list (for example first in `freelancers/reviewer.yaml`). Restart the surface and the daemon
after changing `providers.yaml`.

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

Verification commands (`verify:`) run in the sandbox, not on the desk: the home directory is read-only and `/tmp` is
private, and only the desk and the tool caches are writable. A test that writes under `$HOME` (for example Ansible's
default `~/.ansible/tmp`) passes on the desk and fails verification, so point such tools at a temporary directory
the test creates (`ANSIBLE_LOCAL_TEMP`, `ANSIBLE_REMOTE_TEMP`). A failed verification returns the end of each failing
command's output (`DESK_CHANGE_LIMITS.failedOutputChars`) to the owner.

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
Owners get a read-only baseline (`READ_ONLY_CHAT_BASH` in `chat-permissions.ts`) and repository-changing owners
get local edit/development conveniences. Explicit declared denies override these, including execution sessions
and descendants; scratch/skills conveniences are not new authority. Chat bash is still unsandboxed.
Implementer and task-review models are optional; local execution/review retains host verification and the one
final independent-family publication review.

`onionsoup_friction({ summary, expected, actual, evidence? })` captures unexpected engine behavior from an
owner chat. The host adds the originating session, running engine checkout commit, observed model and bounded
failed-tool context; it never stores raw tool arguments. Repeated safe error shapes share one report, while a
missing failure event is marked provisional. Reports appear in the surface's Friction view for a person to read;
nothing triages or routes them. `FRICTION_LIMITS` in `packages/owners/src/friction.ts` bounds prose, errors,
session history, records and listings.

`scripts/test.mjs` defaults to `DEFAULT_TEST_CONCURRENCY=4` in child Node argv.
`ONIONSOUP_TEST_CONCURRENCY` or CLI `--test-concurrency=N` supplies a positive safe-integer override;
the CLI wins. Node rejects this flag in `NODE_OPTIONS`. Sandbox memory/task caps and the staging verifier's
existing seven host-bus exclusions are unchanged.

## Give an owner authority

Authority comes only from your configuration:

- `domain.incus.remotes[].allow` decides where instances may be created and deleted.
- `grants:` are standing approvals: `{ to: <owner>, action: publish-site | update-app | merge | ship | approve-plans, target: <name or "*"> }`.
  Without a grant, the runtime asks you.
- `reportsTo: <owner>` puts an owner under a manager (see [Managers](#managers)).
- `manages: { owners: [<glob>, ...] }` makes an owner a steward: with its `onionsoup_owners` tool it creates,
  changes and retires owners whose domain (repository or org name) matches, with your approval for each write. It
  can never write `grants`, `deploy`, `incus`, `mcp` or `manages`, nor change itself.
- `deploy: { checkout, services }` says where a repository owner's code runs; with it the owner can ship
  through the legacy generic checkout ship capability. For onionsoup itself use the
  [immutable guarded deployment worker](deployment.md), not a live checkout fast-forward:
  exact verified release, atomic pointer switch, **both** units restarted and verified rollback.
- Destructive actions, plan approval and creates/deletes always stop for you unless a grant says otherwise.

## Managers

A manager is any owner others report to. Declare the line on each report; a `maintain-prs` duty lets the report
keep the PRs its manager's requests produce mergeable:

```yaml
# owners/murbella.yaml
id: murbella
reportsTo: odrade
duties:
  - { id: prs, kind: maintain-prs, every: 15m, instructions: "Keep published PRs mergeable." }
grants:
  # Optional: Odrade approves Murbella's plans for work Odrade requested; every use is journaled.
  - { to: odrade, action: approve-plans, target: frostyard/snosi }
```

The manager fans cross-repository change out in chat: one `onionsoup_request_work` per report and repository, in
the order the change needs. Each report accepts its manager's request automatically, plans it in a session of its
own, and pushes back with `onionsoup_send` when the work is wrong, unclear or blocked. The manager follows the work
with `onionsoup_status` (`request=<id>` for one request), talks to a report with `onionsoup_send` / `onionsoup_reply`,
and with `onionsoup_steer` cancels a request's work, leaves the report a note on it, or resumes it after an
intentional pause. A steward may put owners in its scope under itself, but only you set any other reporting line or
grant.

With an `approve-plans` grant, the manager reviews the plans of work she sent with
`onionsoup_review_request_plan`; without one, every plan waits for you in the inbox. Read
`onionsoup_status request=<id>` first, then supply its exact `request`, `item` and `digest`, a `decision`
(`approve`, `revise`, `needs-human`), `scope` (`matched`, `needs-human`) and factual `note`. Approve requires matched
scope. Unresolved scope remains pending for the person; approval is never inferred from
request acceptance or an earlier conversational promise. A separate durable review
continuation wakes the requester in the original chat. The status tool reports missing authority or delivery
blockers, and human approval remains available in the inbox. These operations add no grants or merge authority.

## Your operator

An operator is one agent you direct yourself, outside the owners: it runs with nearly every permission, like a
coding agent in auto mode, and irreversible commands ask you first. Declare it in `operator.yaml` at the top of your
config directory; without the file there is none.

```yaml
# operator.yaml
name: Operator                   # its agent name; no owner may use it (default Operator)
title: Acts for you              # shown under its name in the surface (default "Acts for you")
icon: terminal                   # an owner persona icon (default terminal)
model: github-copilot/gpt-6-sol
directory: ~/projects            # where its chats run (default ~/projects)
ask:                             # more bash patterns that ask you, on top of the built-in irreversible ones
  - "systemctl --user stop*"
```

Restart the surface; the operator appears at the top of the rail. It may use the onionsoup CLI and the skills in
`.agents/skills` like you would, but approvals and ships through the CLI ask you, and it has no owner tools but
`onionsoup_wiki`, with which it reads the wiki. For parallel work it dispatches opencode `task` subagents. What it
and its subagents run is journaled to `state/notebooks/operator/journal/`. See [Operator](design/owners.md#operator) for why it sits
outside the owner rules and what it risks.

## Keep a wiki

Onionsoup keeps a wiki of markdown pages in a git repository that one owner, its keeper, writes and
everyone reads. Declare it in `wiki.yaml` at the top of your config directory; without the file there is none.

```yaml
# wiki.yaml
repository: git@github.com:you/homewiki.git   # each write is pushed here at once, as the backup
branch: main                                  # default main
pagesDirectory: docs                          # where the pages live in the repository (default docs)
keeper: bellonda                              # a declared owner: the only one who writes
```

The surface serves the read-only wiki at `http://127.0.0.1:4747/wiki/`, on the existing
localhost surface with no second listener. `listen` is obsolete and ignored by this release; keep it in your live
configuration while an older release requiring it is a rollback target. The wiki clone lives
at `<ONIONSOUP_HOME>/wiki`. Owners read it with `onionsoup_wiki`, and the keeper writes, moves and deletes pages with
it; each write is committed as the
keeper and pushed, and a delete asks you first. Pages may start with YAML frontmatter: `title`, `order` (the sidebar
sorts by it, then by title), `updated` and `sources`. If the wiki was an MkDocs site, run
`npm run owners -- wiki migrate` once: it moves `mkdocs.yml`'s nav order into frontmatter, deletes `mkdocs.yml`, and
pushes. See [Wiki](design/owners.md#wiki).

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

Create `~/.config/onionsoup/briefings/<name>.json` with the owner, an absolute state directory, and the
instruction you want repeated:

```json
{
  "id": "daily-briefing",
  "owner": "your-owner",
  "surfaceUrl": "http://127.0.0.1:4747",
  "stateDirectory": "/absolute/path/to/onionsoup/state/briefings/daily-briefing",
  "timezone": "America/New_York",
  "localTime": "09:00",
  "prompt": "Prepare today's briefing in this chat. State evidence dates and decisions needed. Observe only."
}
```

Each run opens a fresh chat for the owner titled `Briefing <runKey>` (the scheduled date), records its ID as the
run record's `sessionID`, and names the previous run's chat in the prompt. The owner's notebook and open work reach
every chat through the plugin; a single pinned chat instead grew to ~490k tokens of context that every briefing
paid to re-read. A `sessionID` left in an older config is ignored.

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

The smoke test opens a chat, sends a real prompt and waits for the owner's completed answer. Its separate key does
not consume the next scheduled date. Conversation permissions still apply; a briefing that asks for permission may
need a person to finish it. A retry reuses the chat its run already opened. The runner records each run atomically
under `stateDirectory`.
A successful POST alone is not completion: the runner
requires a completed, non-error assistant answer linked to its own prompt. The prompt marker reconciles retries
against the persisted transcript. If submission is uncertain and the marker cannot be found, the runner fails
with a reason instead of submitting a possible duplicate. Inspect the transcript before resolving that record.

Records live in `stateDirectory/<id>/<runKey>.json`; `<runKey>.intent.json` is the durable submission claim.
For `submission_ambiguous`, stop the service and inspect the run's chat (the record's `sessionID`) first. If the
marked prompt exists, preserve both records and retry monitoring. Only after establishing that no prompt was
accepted should you archive both files outside that directory and restart the service. A crash immediately
before the POST also requires this check. HTTP rejections stay conservative because a downstream error alone does not prove that no
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

An `onionsoup_ask` exchange is journaled for both owners (`asked`, `answered`) and shows in their recent activity;
it is not posted into a chat. The plugin still drains exchange notices already in the durable queue every 15
seconds. It selects the owner's latest person message among the inspected sessions, ignoring synthetic messages,
runtime notices and other agents. Delivery uses `noReply`, so it adds transcript evidence without hiring an owner or watcher. Unreadable candidate sessions (including structured-output hires) are logged and skipped. Busy chats, failed
session listings and missing person chats leave the notice queued. Exchanges survive plugin restarts; accepted posts use a stable
message ID to avoid duplicates after acknowledgement loss. Full records are retained under
`$ONIONSOUP_HOME/notices/exchanges/pending` or `delivered`, with absolute paths and their ID cited in the transcript. Owners without a persona do not queue new chat notices;
legacy notices for personless or retired owners move to `undeliverable` with a reason. Discovery reloads
configuration before treating an unknown owner as retired, so an older plugin cannot discard a new owner’s notice. If the owner's
person chat is older than the configured session search window, raise `noticeSessions` or speak in that chat.
Restart the surface after installing plugin changes.

For conversation in an owner's actual context, use `onionsoup_send { to, text, item?, session? }`, not
`onionsoup_ask`'s separate read-only consultation. Name the recipient's item for an exact work continuation, or
a host-observed session `{ sessionID, directory }`. `onionsoup_reply { message, text }` answers the delivered
notice ID at the recorded sender address. These tools are available to persona owners, not subagents or
observation-only identities. Delivery waits for idle, preserves sender/content and reconciles exact transcript
receipts on restart. A retired workspace routes to one fresh declared-workspace continuation with retained
history; it is never recreated. Manager notes use this same queue. Conversation
does not grant new repository, model, credential or destructive authority, and existing effect gates still apply.

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
decisions use `approvePlan`, `revisePlan`, `pauseItem`, `resumeItem`, `retryItem` and `cancelItem`; cancellation of active work is
refused. Desk publication (also used by approved plans and CI repairs) keeps its persisted stage to reconcile
retries against the local commit and existing GitHub PR before repeating effects.

Use `owners pause <item> --reason "Intentional stop"` for a deliberate stop, not crash recovery.
The surface's Pause control and Stop in a linked work conversation use the same host action. The receipt
first records `pausing`; the upgraded plugin confirms the execution tree stopped before `paused`.
Only exact host-recorded work sessions are stopped; a shared submitting desk conversation stays usable.
With no execution session, the item pauses without aborting that conversation.
Do not erase an active runner or uncertain SDK admission to force that transition. Read the item and its
latest pause receipt before treating it as settled. `owners resume <item> --note "Continue unchanged work"`
or the surface's Resume control restores the exact saved stage and approved goal. This is an explicit human
action, not an automatic restart or a new plan approval. A direct manager's `onionsoup_steer` resume needs
its existing applicable `approve-plans` grant and work she requested.

Persona owners with a declared `maintain-prs` duty can call `onionsoup_update_prs` without repository or head
arguments. The same periodic selector covers `BEHIND` and conflicting PRs; `refresh: true` also updates a
mergeable PR whose head lacks the base tip. Clean base updates retain the old
published head as an ancestor, run configured host checks and use an exact-head protected push.
Conflicts still use owner resolution, independent review and the existing destructive rewrite gate.

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

For reviewed trial changes, pass `draft: true` to `onionsoup_propose_changes` or use
`owners propose <owner> --item <item> --draft --note <title>`. This persists a no-merge
publication boundary even when the owner has a merge grant. To recover an approved request
whose PR was published externally, the person uses `owners reconcile-pr <owner> <item> <url>`;
see [draft publication and recovery](design/owners.md) for its exact-source verification and
review requirements. For a historical merged-PR fact without accepted completion, use
`owners observe-merged-pr <owner> <item> <url>`. It preserves current review findings as
follow-up and leaves the request open; it does not run another review or dispatch work.
None of these operations establishes deployment.

For an approved delegated infrastructure/E2E task with no repository publication, use
`onionsoup_complete_work { item: "<original-item>", action: "complete" }` from its execution session or
host-proven original-work continuation. The tool selects only the original work, not arbitrary resource IDs.
It runs configured sandbox checks, observes supported resource postconditions and hires one final independent-family
reviewer against the original goal. A durable checkpoint repairs completion and requester notification after a
crash without another review or a fake PR. Ordinary create/delete approval remains mandatory.

If legacy evidence is missing, use `action: "reverify"` to queue the owner in that same work context.
Actual resource records need the original host origin, creation checkpoint, accepted decision, exact managed
request identity, effect approvals, required successful host follow-up and positively observed deletion.
Owner reports do not replace them, and re-verification never blindly creates a new VM. The normal
`onionsoup_request_instance` and `onionsoup_release_instance` tools retain their create/delete gates.
Intentional pause must be explicitly resumed before completion or re-verification; unchanged approved work
does not need the repository closure-candidate/human-acceptance ritual below.

For a historically merged request whose outstanding findings were fixed by later merged PRs,
the person can prepare and explicitly accept closure:

```sh
owners prepare-request-closure <owner> <item> --directory /path/to/clean-integrated-checkout --follow-up https://github.com/org/repo/pull/107
owners accept-request <owner> <item> <printed-closure-digest> --note "Why the original scoped goal is satisfied"
```

Repeat `--follow-up` for each relevant merged fix. Use a separate clean worktree at the fetched
configured base tip; keep the original plan worktree and review history intact. Preparation verifies
GitHub merge facts and local ancestry, runs every configured verification command, and hires the
configured reviewer from another model family against the original goal, approved plan and historical
findings. It prints the evidence and digest; it does not complete the request. Inspect that evidence
before accepting. Missing evidence, unresolved findings or an unmerged follow-up block preparation.
Repeating unchanged preparation reuses its still-fresh candidate without another review.

Acceptance requires that exact digest, a nonempty rationale and unchanged scope, configuration,
source and merge facts. Evidence expires after the repository’s `requestClosureEvidenceMaxAgeMs` (default 24 hours);
changed or expired evidence needs fresh preparation. The command records the local account as the
person accepting, retains the original records, marks the work landed and completes its linked request.
An identical acceptance retry repairs the request projection after interruption without recording a
second acceptance. A different digest or rationale cannot replace an existing acceptance.

These are trusted host CLI actions under the existing runtime/admission lock, not owner MCP tools or
new standing grants. A running daemon's runtime lock can require the normal guarded maintenance window;
do not interrupt active work to run them. The surface and coordinator show the acceptance receipt,
verified follow-ups and original historical review separately. Repository acceptance does not attest
deployment, close unrelated friction reports or dispatch more work.
