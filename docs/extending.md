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

## Give the operator parallel investigations

An existing `operator.yaml` also enables `onionsoup_operator_job`; no owner or standing grant is needed. Ask the
operator, for example: “Investigate the configuration and its tests in parallel. Read only; report the evidence.”
It can create two bounded child tasks, keep answering your chat, and receive progress and completion events. Jobs
retain the original request and exact child sessions across runtime restarts. `show` reads progress; `pause`, `resume`
and `cancel` are scoped to that chat's jobs; `synthesize` records a summary against the children's evidence digest.
If a runtime outcome remains unknown, `recheck` inspects the same child once. `recovery-preview` and `abandon` let
the person release that exact reservation through a one-time permission decision. The unknown outcome and transcript
remain preserved; no replacement is launched and no permission is remembered for later jobs.
These jobs do not drive domain owners. Read-only behavior is unchanged; write tasks use the separate gates below.
See [durable operator investigations](design/owners.md#durable-operator-investigations) for recovery behavior.

### Approve bounded file edits and checks

Use an existing clean Git worktree under the operator's configured directory. Ask for the exact goal, constraints and
files and checks, for example: “Update the README title, add `test/title.test.mjs`, and run it with Node’s test runner;
do not commit.” The `test` directory must already exist. The operator can call:

```json
{
  "action": "create",
  "job": {
    "key": "readme-title",
    "goal": "Update the README title and add a regression test",
    "constraints": ["Only the title line and named test", "No commits"],
    "tasks": [{
      "id": "title", "goal": "Update the title and verify it with the named test",
      "directory": "/home/you/projects/docs-worktree",
      "access": "write", "files": ["README.md"], "createFiles": ["test/title.test.mjs"],
      "checks": [{ "id": "title-test", "command": ["node", "--test", "test/title.test.mjs"] }],
      "dependsOn": []
    }]
  }
}
```

1. Inspect the original request, goal, existing/new paths, exact check commands and baseline HEAD in the permission
   card, then choose **Allow once**. Existing files must be tracked UTF-8 text; new files must be explicitly named, absent
   and nonignored, with existing parent directories. A second independent worktree may run concurrently; an
   overlapping workspace claim is refused even when it names different files.
2. The child edits through the host’s bounded file tool and requests approved checks by ID. Checks accept `node --test`
   plus literal relative paths, `go test` / `go vet` plus local package paths such as `./...`, or project argv such as
   `["project", "make", "check"]` or `["project", "sh", "scripts/validate.sh"]`. Project commands run with host-selected
   tools in a writable disposable source copy, without network, credentials or live worktree access. Go checks require
   a host-selected toolchain and a self-contained module. You can keep talking to the operator while checks run.
3. When the job reports `needs-review`, the operator calls `onionsoup_operator_job` with
   `{ "action": "review-write", "id": "<job>", "childID": "title" }` and presents the host diff and check receipts.
   Every approved check must pass against the current artifact before acceptance; later edits require fresh checks.
4. The operator requests `{ "action": "accept-write", "id": "<job>", "childID": "title", "digest": "<review digest>" }`.
   Review the full diff, command/exit-code receipts and artifact digests, then answer the new **Allow once** prompt.
   Changed evidence invalidates that decision; no persistent permission is added. Acceptance releases the workspace
   claim. It neither commits the change nor certifies tests beyond the shown host-run checks or independent review.
5. After every child is complete and required edits are accepted, `show` supplies the current job digest and evidence
   message IDs for `synthesize`. The edits remain in your worktree for your normal verification and Git workflow.

Project validation requires the service operator to set `ONIONSOUP_PROJECT_TOOLS_FILE` to an absolute JSON file:

```json
{ "tools": { "make": "/usr/bin/make", "sh": "/usr/bin/bash", "git": "/usr/bin/git" } }
```

Select installed ELF executables, including the shell and utilities the project's recipes need; do not put credentials
or project-controlled host paths in this configuration. The runner requires the host's `readelf` and `ldconfig` to
inspect shared libraries. It pins verified private copies of tools and libraries and records their SHA256 hashes in
check receipts. Adding a tool changes the runtime profile, not a persistent model grant. Approved project commands
may invoke repository scripts or arbitrary argv inside this sandbox; there is no command-name whitelist. They may
write build output or initialize synthetic Git fixtures there, but those changes are discarded. The snapshot excludes
`.git`, host configuration and dependency caches. Tool downloads are unavailable; mise tasks can use installed PATH
tools. A mise version declaration does not select host bytes or prove the PATH executable has that version; validate
the actual tool version when it matters. Missing tools must be supplied by the host; no installer runs automatically.

Repository-internal file and directory symlinks retain their exact target text in snapshots, checks and combined
application. Escaping, absolute, dangling, cyclic or `.git`-targeting links fail closed. Symlinks are read-only inputs;
write scopes still name regular files. A canonical `AGENTS.md` can be edited while its instruction aliases stay intact.

For accepted changes in sibling worktrees of one repository at one base, ask for a combined handoff:

1. `onionsoup_operator_job { "action": "prepare-handoff", "id": "<job>" }` returns its digest and named checks.
2. Call `{ "action": "check-handoff", "id": "<job>", "digest": "<handoff digest>", "checkID": "<returned check ID>" }`
   for each returned check, sequentially. Only commands already approved for that job can run; no new scope prompt is needed.
3. `{ "action": "show-handoff", "id": "<job>" }` reports progress and the complete patch/JSON report paths.
   The operator remains available while checks run. A failed combined check is useful evidence even when each child
   passed alone. Unknown completion is preserved across restart, never automatically retried. Use the recovery actions below for a supported resolution.
4. Review the exact combined diff and check receipts. A report with no configured checks is `unchecked`, not verified.
   Preparing/checking alone never applies changes, commits or pushes.

Overlapping approved paths, different repositories/bases, stale files, unaccepted children or incomplete runtime
evidence block a handoff. Its report preserves the original task, approvals and child history separately from combined
verification. Previously recorded synthesis is not rewritten or retroactively presented as combined verification.

To apply a ready combined result into a designated clean integration worktree of that same repository/base:

1. `{ "action": "preview-application", "id": "<job>", "directory": "<absolute integration worktree>" }`
   binds the original goal, accepted child evidence, successful combined checks and exact destination baseline.
2. `{ "action": "apply-handoff", "id": "<job>", "directory": "<same destination>", "digest": "<application digest>" }`
   presents **Apply combined result** with the full diff, checks and destination. **Allow once** authorizes only that
   exact application; it does not authorize a commit, push, merge or publication. The parent returns while it runs.
3. `{ "action": "show-application", "id": "<job>" }` reports file progress, any blocker, the durable evidence path,
   and the final source digest. `show-handoff` also exposes this separate application status.
4. An exact retry uses the saved approval and destination. After restart, positively stopped completed file writes
   are recognized from their durable identities and never repeated. An unchanged preimage may resume within the
   bounded attempt limit. Partial, foreign, missing or unproven outcomes keep the exclusive reservation. Do not
   delete staging files or edit records to bypass a blocker.

The target must be a clean sibling worktree, not a child workspace or another checkout with merely matching commits.
One application per job and one active application worker are supported. Original child artifacts, HEAD and index are
preserved; the destination deliberately remains uncommitted. Managed workspace claims exclude other onionsoup work,
not unrelated editors. Preparation interrupted before its staging identity is saved remains blocked for inspection.
Applying to another destination needs a new scoped job; approval is never rebound silently.

For a combined check left `uncertain`, use the receipt ID returned by `show-handoff`:

1. `{ "action": "recovery-preview-handoff", "id": "<job>", "receiptID": "<check receipt>" }`
   displays the exact digest, original goal, saved outcome or process observation, and eligibility reason.
2. `{ "action": "recover-handoff", "id": "<job>", "receiptID": "<check receipt>", "digest": "<preview digest>", "text": "<factual recovery note>" }`
   imports an existing host completion, or asks **Allow once** to release a positively stopped check with no result.
3. Read `show-handoff` again. A stopped unknown result remains `unverified`; its command is never replayed and the
   original job/child acceptance is unchanged. An identical recovery call reuses its first resolution and safely
   finishes only exact-identity admission cleanup if that was interrupted. The same procedure cleans up a retained
   admission after normal completion, preserving that completed receipt without another approval.

These actions are available only to the configured operator in the original parent chat. They do not infer success
from elapsed time, a dead plugin lease or a model statement. Live/zombie/foreign processes, changed identity domains,
unknown outcomes with missing journals and legacy receipts without execution provenance remain protected. A new attempt needs a separately
scoped job; recovery creates none. No production restart or manual state edit is part of this procedure.

To enable Go checks, the trusted service environment must set `ONIONSOUP_HOST_GO_ROOT` to the canonical absolute
root of an installed Go toolchain (for example `/opt/go`). This selects runtime files, not a new authority grant.
Missing or invalid toolchains fail before check intent is recorded. A task supplies only commands such as
`["go", "test", "./..."]` and `["go", "vet", "./pkg"]`; it cannot supply a runtime path or arbitrary flags.
Checks use private caches and disable CGO, automatic toolchain downloads, module downloads and `go.work` discovery.
Only dependencies present in the verified source tree and the selected standard library are available; package
installation and networked dependency preparation remain separate unsupported actions. Development verification
and isolated staging also require this environment variable for the real Go integration tests. CI pins Go 1.25.8.

Retrying the exact approved `create` call returns the same job without another scope prompt or child launch. This
does not authorize changes to the request, paths or commands. The first scope prompt remains required: removing it
needs an explicit structured-intake product decision, not natural-language inference or a new standing grant.

An uncertain prepared write remains blocked and holds its reservation. Do not retry it, abandon it through read-only
recovery or assume a restart undid the edit; this slice has no uncertain-write recovery. The file writer uses a pinned
descriptor in a sandbox; the parent operator remains trusted and unsandboxed. Scoped writes require bubblewrap
descriptor binds (`--bind-fd` and `--ro-bind-fd`, version 0.10 or newer); unsupported hosts refuse before recording
a mutation intent. CI builds the pinned 0.12 release and runs the actual writer tests.

If a queued, blocked or needs-review write child recorded no mutation, use `recovery-preview` and its exact digest with `abandon`.
The host must verify absent or idle owned runtime state without live tools, and the person must answer the existing
one-time recovery prompt. This releases the reservation without completion or replacement. Unavailable, busy,
foreign or any recorded-mutation state is ineligible.

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
  structuredOutput: true              # false: hires on its models ask for their JSON in the reply text
```

The plugin adds it to the surface opencode's providers (your own opencode providers stay; one with the same id is
replaced), and every sandboxed hire gets the same provider in its own opencode config, since the sandbox hides
`~/.config/opencode`. Ids of opencode's built-in providers (`openai`, `anthropic`, `github-copilot`, `google`, …) are
refused. Hires ask for structured output through a forced tool call; a model that refuses it, or answers without
calling the tool, gets the hire again once in text mode, and later hires on it start there. Set
`structuredOutput: false` when you know the endpoint cannot do it, to skip the failed first round.

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

Everything else follows the owner's `conversation:` rules: `allow`, `ask` (approve in the chat) or `deny`. Every owner also gets a read-only baseline (`READ_ONLY_CHAT_BASH` in `chat-permissions.ts`: `grep`, `rg`, `sed -n`, `cat`, `head`, `tail`, `ls`, `find`, `jq`, git and `gh` queries) between its catch-all and its own rules, so it reads without asking; an owner's own specific rule still wins. Its opencode scratch space and the skills directory need no approval either.

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

For direct work requests the manager personally sent, the same applicable grant enables
`onionsoup_review_request_plan`. Read `onionsoup_status request=<id>` first, then supply its exact `request`, `item`
and `digest`, a `decision` (`approve`, `revise`, `needs-human`), `scope` (`matched`, `needs-human`) and factual `note`.
Approve requires matched scope. Unresolved scope remains pending for the person; approval is never inferred from
request acceptance, a delivered progress notice or an earlier conversational promise. A separate durable review
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
`onionsoup_wiki`, with which it reads the wiki. What it
runs is journaled to `state/notebooks/operator/journal/`. See [Operator](design/owners.md#operator) for why it sits
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

For conversation in an owner's actual context, use `onionsoup_send { to, text, item?, session? }`, not
`onionsoup_ask`'s separate read-only consultation. Name the recipient's item for an exact work continuation, or
a host-observed session `{ sessionID, directory }`. `onionsoup_reply { message, text }` answers the delivered
notice ID at the recorded sender address. These tools are available to persona owners, not subagents or
observation-only identities. Delivery waits for idle, preserves sender/content and reconciles exact transcript
receipts on restart. A retired workspace routes to one fresh declared-workspace continuation with retained
history; it is never recreated. Manager notes and escalation resolutions use this same queue. Conversation
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

For reviewed trial changes, pass `draft: true` to `onionsoup_propose_changes` or use
`owners propose <owner> --item <item> --draft --note <title>`. This persists a no-merge
publication boundary even when the owner has a merge grant. To recover an approved request
whose PR was published externally, the person uses `owners reconcile-pr <owner> <item> <url>`;
see [draft publication and recovery](design/owners.md) for its exact-source verification and
review requirements. For a historical merged-PR fact without accepted completion, use
`owners observe-merged-pr <owner> <item> <url>`. It preserves current review findings as
follow-up and leaves the request open; it does not run another review or dispatch work.
None of these operations establishes deployment.

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
