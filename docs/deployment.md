# Release deployment (manual bootstrap)

The [owners](../deploy/onionsoup-owners.service) and [surface](../deploy/onionsoup-surface.service)
user-unit templates run from a stable release root, not from a moving development checkout. They
do not install themselves or implement a readiness protocol: `Type=simple`/`is-active` alone only
reports a running process. Installing a template, changing a symlink, reloading systemd, restarting
a service, or enabling a timer is an explicit operator action. Editing these files changes no live
service.

## Layout and prerequisites

The templates use `$HOME/projects/onionsoup-release` as the release root. Change **both** units and
`ONIONSOUP_RELEASE_ROOT` together if you choose another absolute location. The layout is:

```text
$HOME/projects/onionsoup-release/
  current -> /absolute/path/to/onionsoup-release/releases/<old-commit>
  releases/<old-commit>/
    packages/owners/src/cli.ts
    packages/owners/src/plugin.ts
    packages/surface/src/main.ts
    packages/surface/web/dist/
    packages/surface/release-manifest.json
    node_modules/
```

`<old-commit>` is the full 40-character Git commit ID of the **actual** installed release.
`release-manifest.json` contains `{"buildId":"<old-commit>"}` with that same ID. The tree must
include its matching installed dependencies and built surface assets. Use a release verified with
`npm ci && npm run verify`; do not label an arbitrary checkout with a commit it does not contain.
The surface validates and captures this manifest's build ID once at process startup; its
`/api/state` keeps reporting that running process's ID even if `current` switches while it is
alive. A newly started surface reads the new manifest, while pending deployment intent is read
on each state request. A missing manifest reports a null build ID for migration; an invalid
manifest prevents startup.
Keep releases immutable after verification, keep the previous release available for rollback, and
keep `ONIONSOUP_HOME` (runtime state) and `ONIONSOUP_CONFIG` (personal declarations) outside the
release root. Back up those directories separately; switching the code pointer does not roll back
state or migrations.

The worker in [`deploy/onionsoup-deploy.service`](../deploy/onionsoup-deploy.service) is a **separate,
stable** install at `/opt/onionsoup-deploy` with its own `node_modules`, outside the release root.
Both service templates explicitly set `ONIONSOUP_HOME=%h/.local/share/onionsoup`; the engine's
state directory is `ONIONSOUP_HOME/state`. Set absolute `ONIONSOUP_STATE` in `deploy.env` to
`/home/USER/.local/share/onionsoup/state` (substitute the actual absolute home path), matching
both services. The service templates set `ONIONSOUP_CONFIG` to `%h/.config/onionsoup`;
set the worker's absolute `ONIONSOUP_CONFIG` to that same resolved directory (or change all
three together for a custom configuration). Also supply absolute `ONIONSOUP_RELEASE_ROOT` and
`SURFACE_URL`. The worker discovers the surface's authenticated opencode endpoint from its
state directory; do not pass `--opencode-url` or put `OPENCODE_URL` in `deploy.env` for the worker.
The installed worker, units, and environment must be reviewed together before use. Do not put
passwords, API keys, or personal declarations in a unit or this repository; if credentials are
needed, store them in an access-restricted environment file outside the release root.

## Manual migration and bootstrap

1. Inspect the existing user units, current processes, opencode plugin registration, configuration
   and state paths, active work, and pending chat questions. Choose a quiet window; stopping the
   daemon interrupts in-flight work, and stopping the surface cuts off chats. Record the original
   unit contents, plugin URL, release path and build ID before any switch. Make a restorable backup
   of configuration and state. Leave the old checkout and old release intact.
2. Prepare and verify the initial release at `releases/<old-commit>` without switching running
   services. Install dependencies, build and verify it; write its matching
   `packages/surface/release-manifest.json`. Create `current` as a symlink to the **absolute**
   verified release path. Confirm `realpath current`, the manifest and the commit agree before
   installing either template. The worker rejects a missing pointer, a non-symlink, or a pointer
   outside `releases/`.
3. The host opencode reads `~/.config/opencode/opencode.json` (or its configured equivalent).
   Migrate its `plugin` entry from the development checkout to an absolute `file://` URL through
   the stable pointer, for example:

   ```json
   {"plugin":["file:///home/USER/projects/onionsoup-release/current/packages/owners/src/plugin.ts"]}
   ```

   Substitute the real absolute home path; `~` and `%h` are not URL expansion in JSON. Preserve
   other plugin entries and opencode settings. Ensure the plugin source and its dependencies exist
   in both the old and next release. Sandboxed hires load the plugin beside their engine module;
   this entry is for the host opencode used by the surface. Do not load both old and new copies.
4. Copy the two templates into `~/.config/systemd/user/`, inspect their paths and environment,
   then run `systemd-analyze --user verify` on the installed copies. Only after confirming that
   work is quiescent, deliberately run `systemctl --user daemon-reload` and restart the owners
   and surface services one at a time. Check their journals, the surface `/api/state`, the plugin
   agents, and the manifest build ID. An active unit is not proof that a chat, plugin, or API is
   ready. Do not enable a deployment timer during bootstrap.

**Bootstrap rollback:** if any check fails, stop further changes. With work still quiescent,
restore the saved plugin entry and original units. If `current` changed, verify that the saved
target is the intact release under `releases/`, then replace the pointer atomically on the same
filesystem (substitute the paths and recorded commit before running):

```bash
root="$HOME/projects/onionsoup-release"
old="$root/releases/<old-commit>"
test -d "$old" && test -f "$old/packages/surface/release-manifest.json" || exit 1
test -L "$root/current" || exit 1
ln -s "$old" "$root/.current.rollback.$$" && mv -Tf "$root/.current.rollback.$$" "$root/current"
```

Confirm `realpath "$root/current"` is `$old`; reload and restart the affected services deliberately.
Check their actual API/plugin behavior and build ID again. If the previous state or configuration
is incompatible, restore its backup as a separate, deliberate recovery; a symlink swap cannot do
that. If the old release cannot be verified healthy, leave automated deployment disabled and
investigate rather than declaring rollback successful. Never delete the prior release or clear a
deployment drain gate merely because a process is active.

## Guarded deployment: bounded checks with accepted residual risk

The worker stages a commit from an explicit source, runs `npm ci` and `npm run verify` in the
sandbox, checks the build manifest, records a rollback checkpoint, switches `current` atomically,
restarts the two units, checks the surface's `/api/state` opencode status and matching build ID,
then releases the drain. On failure it switches back, restarts and verifies the previous build;
an unverified rollback keeps the gate held for operator intervention. The worker is not an
installer and `arm` does not silently replace a running release. `status` reads the pending
intent; `cancel` is for a deliberately cancelled pending deployment, not an override for a
failed or unverified rollback.

Staged `npm run verify` excludes the nested sandbox test
`a sandboxed npm ci succeeds in a minimal fixture, with private XDG roots and the worktree writable`:
it needs a host user bus to start a nested sandbox, and the isolated release stage has no host bus.
Six desk-review, external-publication and delegated-evidence integration tests that execute configured
host checks also require that bus; the exact names are listed in `scripts/deploy-stage.mjs`.
All seven still run in ordinary Linux verification and CI; only the isolated stage excludes their
exact names. The filter is quoted so spaces cannot silently exclude other tests.
The stage prints these exceptions when verifying. It does not depend on `ONIONSOUP_DEPLOY_E2E`
(which only opts into the outer real-archive test); ordinary `npm run verify` still runs all seven tests.

The drain stops new admitted turns and requires all live leases to finish. The worker reads
`/session/status`, `/permission`, and `/question` for every declared owner chat/desk, operator
directory and recorded plan/session directory; missing, malformed or unreadable responses hold
the gate. It rejects another same-user opencode process detected through `/proc`. After a
five-second quiet interval it probes every second, and rechecks just before the atomic pointer switch.
The plugin periodically reconciles a chat lease if its idle event was missed: its own
directory-scoped status must report idle and its last assistant message must have completed
with a final stop after the admitted turn's persisted user-message ID. Children are enumerated
in the same directory and require idle status plus a final answer or a completed idle event.
The plugin rechecks status, transcript and child evidence at release. Missing,
unreadable or malformed evidence retains the lease, as do in-flight messages, tools, children
and operator memory nudges. A held lease therefore needs investigation rather than manually
clearing the drain on the strength of an absent status alone.

Host exchange notices use a bounded delivery admission rather than a chat-turn admission. The
plugin recognizes only a one-use, expiring delivery capability from the running host publisher,
matched to the message, agent, directory and top-level session. The capability is removed before
the message is persisted. A copied prefix, delivered notice ID, ordinary `noReply` API call, or
message from another process does not authorize this bypass. A callback carrying an expired,
consumed or unknown delivery capability is rejected before chat bookkeeping; a client timeout
does not prove the server stopped. Ordinary messages without a capability retain normal gates.
Exact delivered notice evidence may be ignored when checking a genuine turn's final reply. A
later human message, changed notice, pending delivery or unknown entry remains blocking.

### One-time bridge for the 04d26ea → 41aed2f deployment

If the **already staged** target is `41aed2f0301d86f52e51f63aa9628faa70f5a233` and
`current` still points to `04d26ea4857933f47b9b9650003706a6c70dc142`, the old
opencode can retain live PID-bound chat leases even after its sessions go idle. The stable
worker waits for those leases and cannot start its own drain. The one-time external
`bootstrap-leases` command is for that exact transition. The previously installed stable
worker does **not** have this handler; invoking it at `/opt/onionsoup-deploy` returns
`unknown_command`. First prepare a separately reviewed bootstrap installation from the
verified code containing this command and its matching `scripts/`, `packages/owners/`,
`package.json`, lockfile and installed `node_modules`. Place the complete tree at a distinct,
absolute path (for example `/opt/onionsoup-bootstrap-41aed2f`), and verify its contents and
dependencies against the reviewed artifact before use. Install it while no bootstrap process
is running, by copying to a new directory and atomically renaming that directory into place;
never copy files into a running executable tree. **Do not overwrite or change** the stable
worker installation, its service/timer command, or the currently running worker. The
bootstrap process and stable timer share `deploy/worker.lock`, while the old worker remains
able to process its existing checkpoint format. Run the separately installed command in an
independent oneshot/timer **outside any surface/opencode chat**, with
the same absolute `--root`, `--state`, `--config` and loopback `--surface-url` used by
the worker, and both explicit expected full commit IDs:

```text
node /opt/onionsoup-bootstrap-41aed2f/scripts/deploy-release.mjs bootstrap-leases \
  --root /absolute/release/root --state /absolute/onionsoup/state \
  --config /absolute/onionsoup/config --surface-url http://127.0.0.1:4747/ \
  --expected-old 04d26ea4857933f47b9b9650003706a6c70dc142 \
  --expected-target 41aed2f0301d86f52e51f63aa9628faa70f5a233
```

It takes `deploy/worker.lock` against the timer, checks the exact pending intent,
old pointer and manifests, authenticates the old opencode endpoint from its surface
process identity, and accepts only live `chat:<session-id>` leases owned by that
child PID and `/proc` start time. It probes known directories for busy statuses,
permissions, questions, and independent opencode processes; for every leased parent
and every descendant in its directory it requires the latest user message to be
followed at the transcript tail by a completed assistant `stop` with that user's
`parentID`. Missing or malformed transcript, ancestry or child enumeration holds the
lease. These checks run through
the same quiet interval on both sides of the admission-locked drain. If quiet, it
restarts **only** the old surface (and its opencode child), verifies old-build health,
changed child identity and dead leases, then leaves the intent **draining**. The
existing worker timer finishes the target activation. A busy or unreadable probe
before restart reopens admission where safe; uncertain post-restart health retains
the drain and a bootstrap marker at `deploy/rollback.json` that the old worker's
checkpoint validation also refuses; the timer and cancel path stay blocked for
investigation. Check pending intent, endpoint and service health before
retrying. This command is deliberately single-use for these two commits and does
not install the worker or enable a timer.

It checks both user units, the surface's reported build ID and opencode status, and the authenticated
`/global/health` on the opencode child whose private endpoint record matches the live surface
process. The worker never accepts a caller-chosen opencode URL. The surface URL is the configured
loopback endpoint from `deploy.env`, distinct from the private opencode endpoint.

**Accepted best-effort risk:** directory enumeration cannot establish global chat quiescence;
an unknown directory or a new independent process between `/proc` scans can escape observation.
The surface's public `/api/state` can be spoofed by a local listener and its reported build ID
does not prove which plugin opencode loaded. These are bounded checks, not a guarantee that every
chat is idle or the plugin is correct. An unreadable `/proc`, endpoint or status read holds the
gate. The person explicitly accepted this residual risk for shipping; monitor the first run and
keep the previous release and checkpoint available. The sample units still use `Type=simple` and
do not signal readiness.

Bootstrap the stable worker outside `current`, set and check
`deploy.env` with matching absolute paths and the loopback surface URL, and verify
the old build's health before explicitly arming a full commit ID. Only then consider enabling
the timer. If activation or rollback fails, inspect `ONIONSOUP_STATE/deploy/pending.json` and
`rollback.json`, `current`, the unit journals, and actual API readiness before any manual
recovery; preserve the checkpoint and held gate until the old build is verified. Do not hand-edit
the pending record to force release of the gate.

## Explicit inactive child recovery

A historical child with an unfinished reply can keep its parent's admission held even when the
server reports idle. A structured-output HTTP 400 is not evidence that the child completed.
`scripts/recover-child.mjs` is an operator-only, explicit abandonment path; it is not a model tool
and never deletes history, synthesizes a final answer, edits upstream records, or clears leases.
Run it with absolute `--state`, `--config`, `--directory`, `--parent` and `--child` to preview.
After the person approves that exact inactive child, repeat with the returned `--approve-digest`
and a `--reason`. No other child is authorized by that approval.

The command checks all known session directories for activity and pending prompts, refuses independent
opencode processes, requires a completed parent and a child with no descendants, and repeats its
checks while holding the admission lock against new turns. An immutable receipt and recoverable
original-row backup live in `state/child-recovery/`. Changed history or ancestry invalidates the
receipt. Busy children remain blocking. Abandoned child prompts/tools are refused; continuing work
requires a new session. The parent chat displays the abandonment and a read-only preserved transcript.
Only that approved, unchanged child's transcript uses the SQLite read projection for incompatible
structured-output formats; original formats and unfinished markers remain untouched.

Normal plugin reconciliation and deployment quiescence recognize a valid abandonment as a terminal
operator decision, separately from success. A runtime predating this support must be upgraded through
the guarded deployment procedure; approval is not permission to delete its live lease. Keep any
restart under the existing drain, activity checks, checkpoints and rollback health checks.

Recovery receipts identify both the approving person (`--approved-by`) and the recording OS user. The command, state and live surface must belong to the same OS user. Receipts bind the canonical database path and full original child rows; changed, unavailable or newly extended evidence retains the admission. Every additional child requires its own explicit approval.

### Recovering admissions stranded by informational notices

`scripts/recover-notice-admissions.mjs` is a separate operator-only bridge for a surface whose
older plugin admitted a host `noReply` exchange notice as a turn. It does not delete leases,
rewrite transcripts, manufacture an answer, or treat an unfinished real turn as completed.
The historical `bootstrap-leases` migration above retains its original pinned builds.

First stage the approved target through the normal release process. Keep a separately verified
copy of this recovery command and its dependencies outside the release root, at the reviewed
commit. Supply the exact current and staged build IDs, paths and each selected session:

```sh
node --conditions=onionsoup-source --import tsx scripts/recover-notice-admissions.mjs \
  --root /absolute/release/root --state /absolute/onionsoup/state \
  --config /absolute/onionsoup/config --surface-url http://127.0.0.1:4747/ \
  --expected-old <current-commit> --expected-target <staged-commit> \
  --session <exact-session-id>
```

Repeat `--session` for every selected session. Preview is read-only. It requires that this exact
set accounts for every live admission, that the leases belong to the verified surface's OpenCode
process, and that all known directories are quiet without permissions, questions, independent
OpenCode processes or active item runners. Selected chats must be top-level and have no children.
Each trailing entry must match a durable delivered host notice in identity, target, agent and
complete rendered text; the preceding real turn must have its own completed assistant final.
Legacy delivery records can be reconstructed only for the pinned affected build
`b2db85b5fa46b1d8f6608ab6e1c3e29a75da0f95`; other builds need recorded delivery evidence.

After the person approves the returned digest and exact selection, repeat the command with
`--approve-digest <digest> --approved-by <person>`. The receipt separately records the approving
person and the OS user running the command. The digest binds both manifests, current pointer, endpoint identity,
selected leases, transcript and notice evidence. Apply takes the worker lock, starts the drain,
and repeats the evidence and quiet checks. It writes a durable recovery checkpoint before
restarting only the old surface. Both services must then be healthy on the unchanged old build,
the endpoint must identify a replacement process, and every admission must be dead. Original
lease files and all conversation and notice records remain intact. An immutable completion
receipt is saved under `state/deploy/notice-admission-recoveries/`; the drain remains held so
the existing release worker can deploy the already approved target through its normal checks.

An uncertain restart or failed health check retains `state/deploy/rollback.json` and the drain;
the old worker recognizes the checkpoint and refuses to continue. Repeating the identical
approved command may finish only after proving the replacement healthy and evidence unchanged.
It never retries an uncertain restart. A completed receipt makes later repeats inert. Changed
evidence, additional admissions, or incomplete work requires a fresh diagnosis and approval;
never remove a checkpoint or lease to force progress.
The identical approved digest can resume an interruption between starting the drain and writing
the checkpoint. Failures before a checkpoint reopen admissions; any partial checkpoint remains
held for diagnosis.

### A failed native tool holding a completed tree

OpenCode 1.18.33 skips `tool.execute.after` when a native tool throws. A plugin predating
terminal-error reconciliation can therefore retain the child's tool marker on its parent
after both have finished. Current plugins reconcile an exact persisted terminal error;
the normal idle and final-answer checks still decide when a chat can be released.

For the affected `b2db85b5fa46b1d8f6608ab6e1c3e29a75da0f95` runtime only, the notice recovery
command accepts one additional `--failed-tool-proof /absolute/selection.json`. Include that
tree's top-level session in the existing `--session` list. The JSON selection has these fields:

```json
{
  "sessionID": "ses_exactParent",
  "directory": "/absolute/plan/worktree",
  "toolSessionID": "ses_exactChild",
  "messageID": "msg_exactFailedAssistant",
  "callID": "call_exactFailedPatch",
  "treeDigest": "<64-character SHA-256 from the inspected tree>"
}
```

The read-only `readFailedToolTree` helper in `scripts/failed-tool-admission-proof.mjs` produces
the fingerprint from the verified endpoint's original messages and ancestry. Capture and
inspect it before approval; a new digest is not permission to include new work. The proof
requires the selected native `apply_patch` expected-lines validation error to be the only
tool error in the entire tree, bound to its child's latest user turn. Every parent and
descendant must have its own completed final answer, all tools must be terminal, and the
exact tree must remain unchanged. Busy work, notices after a final answer, new children,
different calls, missing evidence, another runtime version, or another old build refuse
recovery. A completed tree without that failed-call evidence is ineligible.

This proof supplements the existing notice proofs in the same digest, drain, checkpoint,
single old-surface restart and immutable receipt. It does not abandon children, clear lease
files, edit messages or invoke synthetic plugin callbacks. The global activity checks and
uncertain-restart protections above still apply. No recovery or deployment follows from
collecting the fingerprint or opening a draft change.
