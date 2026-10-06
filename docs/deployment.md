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

The isolated stage has no host user bus. Core nested checks reuse its kernel-enforced 6 GiB memory,
512-task and zero-swap budget, without changing their bubblewrap mounts, masks or private environment.
Each required limit must be proved through actual cgroup v2 membership and ancestors; missing or invalid
proof retains the original systemd scope rather than trusting an environment marker.
Sandbox preparation creates missing fixed mask mountpoints before binding the read-only root,
so an empty synthetic stage home can mount the same host-config/state masks without writable-root access.

Staged `npm run verify` retains its existing seven exact-name exclusions: the nested npm sandbox test
and six desk-review, external-publication and delegated-evidence integration tests listed in
`scripts/deploy-stage.mjs`. This compatibility change does not add or remove exclusions.
All seven still run in ordinary Linux verification and CI; only the isolated stage excludes their
exact names. The filter is quoted so spaces cannot silently exclude other tests.
The stage prints these exceptions when verifying. It does not depend on `ONIONSOUP_DEPLOY_E2E`
(which only opts into the outer real-archive test); ordinary `npm run verify` still runs all seven tests.

The drain stops new admitted turns and requires all live leases to finish. The worker reads
`/session/status`, `/permission`, and `/question` for active declared owner chat/desk, operator
and execution directories. Historical terminal session references and archived workspaces are
not active probe targets: probing a removed directory must never initialize an old OpenCode
instance or recreate its workspace. Live leases and actual busy execution still hold the gate,
including when their directory disappeared; absence is not proof of completion. Missing,
malformed or unreadable active-scope responses hold the gate. An open PR alone does not make a missing,
archived terminal workspace an active execution context. It rejects another same-user opencode process
detected through `/proc`. After a
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

### Legacy maintenance recovery plan

The legacy exception is a separate operator-only command, `scripts/recover-maintenance.mjs`.
Its implementation is not authorization to interrupt a runtime. It restores **diagnostic-only
quarantine**, not ordinary chat or execution service. Both units acknowledge the approved target
build and recovery digest, but OpenCode is intentionally not started. The admission drain, original
lease files, interruption checkpoint and unknown outcomes remain held. There is no timeout-based
release, automated replay, or blanket clear operation.
Maintenance lifecycle prevention cannot recover an old `plugin:notices` or `plugin:operator-jobs`
admission that contains only kind, PID and process start time. It supplies no instance, awaited call,
resource identity, request receipt or terminal outcome. A live PID, quiet chats, old timestamp or zombie
lock helper cannot fill that gap. Chat/notice/failed-tool recovery commands do not apply to these leases.

1. Preserve the exact leases, process/build identity, configuration, durable ledgers, session evidence
   and workspace state in a verified backup. Read-only inspection may identify a specific outstanding
   call and its domain receipt. If it cannot, record the outcome as unknown, not completed.
2. Prefer a positive exact-operation terminal receipt and proof that no owned callback or worker can
   still act. Kernel-lock release alone proves neither. Older records normally cannot supply this proof;
   a new prevention build must not backfill invented identities or silently adopt them.
3. When proof is unavailable, a person must separately decide whether to interrupt the exact old runtime
   while preserving unknown effects. The supported procedure drains new work,
   rechecks all genuine chats, tools, children, host checks and descendants, and invalidates its preview
   on any new activity, changed PID/start/build or changed evidence. It must positively establish process
   termination and contain possible outstanding effects before restart. An apparently idle snapshot
   is insufficient. The ordinary guarded-release worker refuses this recovery's checkpoint and quarantine.
4. Retain an immutable receipt that distinguishes **operator-authorized interruption** from completed
   work. Keep old leases and transcripts as history; never rewrite them as successful operations.
   Reconcile or explicitly quarantine uncertain domain effects before allowing a replacement to send
   again. Preserve rollback and verify exact build/health after any separately authorized rollout.

The command's acceptance checks include a disposable-runtime stop with
matching process identity; foreign/new activity invalidating a prepared digest; pending external effects
remaining protected; duplicate/uncertain restart refusal; unchanged transcripts and workspace evidence;
and no notice, opening or child replay. Until the procedure is independently reviewed and its exact
preview explicitly approved, the correct outcome for unproven legacy leases remains **blocked**. The prevention
change alone does not clear them or make an ordinary guarded rollout eligible.

Run the command from a stable, reviewed checkout outside the immutable release root. The target must
already be staged with `capabilities.legacyMaintenanceQuarantine: 1`. Supply the exact legacy lease IDs
and evidence directories covering the selected runtime's OpenCode database and WAL, in addition to
the configuration, durable state and workspaces automatically inventoried by the probe:

The supported launch profile is Linux user systemd with cgroup v2, direct execution through
`~/.local/share/mise/shims/node --conditions=onionsoup-source --import tsx`, the source entrypoints under
`<release_root>/current`, and the declared service environment. Wrappers, environment files, extra
execution hooks, different launch profiles and unrecognized database layouts are refused rather than
assumed equivalent. No live eligibility follows from synthetic tests of this profile.

```sh
node --conditions=onionsoup-source --import tsx scripts/recover-maintenance.mjs \
  --root "$release_root" --state "$state" --config "$config" \
  --surface-url http://127.0.0.1:4747/ \
  --expected-old "$old_commit" --expected-target "$target_commit" \
  --lease "$legacy_lease_id" --evidence-root "$opencode_data"
```

This first invocation is a preview. Repeat the same selection with `--approve-digest` set to that
exact preview digest and `--approved-by` identifying the approving person only after explicit
approval. The preview binds manifests, endpoint and service/process identities, exact lease bytes,
session registry/transcript hashes and configuration/workspace evidence. Changed evidence or genuine
activity invalidates it. Preview output contains hashes rather than transcript or credential contents;
paths and session identifiers remain private operational evidence.

Under the worker lock and admission drain, apply repeats the probes and copies evidence to
`<release_root>/maintenance-recoveries/<digest>/`. Raw copies preserve files and separate online SQLite
backups preserve consistent databases. A second archive after verified termination retains the state
actually left by interruption. Each stop, pointer switch and target start gets a durable attempt record
before execution. Retries inspect those records and observed processes; they never repeat an uncertain
effect merely because a command timed out. Local termination does not prove a remote request was cancelled.

The result `restored-quarantined` means both services expose diagnostics for the exact new build and
acknowledge the quarantine; its separate `outcome: unknown` is intentional. It does **not** mean work
completed, OpenCode is healthy, the deployment gate is released, or the system is ready for new jobs.
`GET /api/maintenance-quarantine` reports this state. All mutations, maintenance dispatch, model prompts,
wiki synchronization and OpenCode startup remain disabled. Missing or invalid quarantine identity fails closed.

Rollback cannot restart an older build that does not implement the quarantine. A failed activation keeps
the checkpoint and drain and leaves the quarantined target or stopped services for diagnosis. The old
release, original lease files, transcripts and backups remain intact. Resuming ordinary work requires
separate evidence-based reconciliation of the unknown effects and an explicitly reviewed release path;
this command provides no generic way to waive that uncertainty.

### Reconcile and release legacy quarantine

`scripts/release-maintenance.mjs` is a separate operator command, not an agent tool or a standing
permission. Use a stable reviewed installation outside the release root. Its target must have both
`legacyMaintenanceQuarantine: 1` and `legacyMaintenanceRelease: 1` capabilities. The saved recovery
receipt supplies the exact configuration, old/target builds and evidence roots; callers cannot
substitute a different target or silently expand the selection.

First prepare observation, using the original recovery digest:

```sh
node --conditions=onionsoup-source --import tsx scripts/release-maintenance.mjs \
  --root "$release_root" --state "$state" --recovery-digest "$recovery_digest"
```

After explicit approval, repeat with `--begin-observation-digest "$observation_digest"` and
`--approved-by "$approver"`. This preserves the original marker/checkpoint and backups, rechecks
stopped original executors and current diagnostic identities, and publishes one durable observation
intent. The capable surface starts its owned OpenCode once. The daemon, chat/tool gates, notebook
initialization, MCP servers, automatic replies and wiki synchronization remain restricted. An uncertain
startup attempt is retained and not retried by another surface process.

Once the exact daemon/surface/plugin observation acknowledgments exist, inspect the release preview:

```sh
node --conditions=onionsoup-source --import tsx scripts/release-maintenance.mjs \
  --root "$release_root" --state "$state" --recovery-digest "$recovery_digest" --mode release
```

The preview inventories all audited durable continuation stores, including absent files and exact
resource bindings. It classifies terminal records and retained single-use claims separately from
blocked continuations. Pending legacy openings without submission identity, unsubmitted wakes,
unsettled application/child work, stale notice cursors and unknown files are named blockers. It neither
abandons them nor treats human approval as proof they completed. This is replay-safety reconciliation;
remote effect outcomes can remain unknown. Actual eligibility is established by the preview, not by
passing synthetic tests or observing idle services.
Terminal requests may retain historical operations and checkpoints when no runner remains; this is
evidence that no automatic request step runs, not a new conclusion about the old effect. Requests that
are still tracking work or can reconcile an interrupted operation remain blocked. Pending reminders
whose due time is in the future are classified as `time-gated`; the earliest such time is the inventory's
`validUntil`. The digest stays stable before that boundary, but expiry or a record change requires new
evidence. Expiry is checked after inventory reads and again immediately before committing release.
No reminder is fired, cancelled or rescheduled by the preview. Finished worktrees remain blocked even
with an old `kept-*` result: current cleanup eligibility needs separate proof. A pending operator wake
without a message identity is an unsubmitted actionable continuation, not proof of delivery or duplication.
This inventory addresses replay of the two selected legacy plugin maintenance producers. Ordinary
daemon duties and memory work resume under their existing gates after release;
the inventory does not declare those unrelated workflows completed or grant them new authority.

An eligible preview binds current processes, authenticated endpoint, all-project session/transcript
and child evidence, configuration/workspace fingerprints, original backups and the exact inventory.
Explicit approval is applied with `--release-digest "$release_digest" --approved-by "$approver"`.
The command repeats the proof, retains its approval audit, disposes the owned idle observation instances
once, and checks global health without recreating restricted instances. Only then, under the admission
lock, does it verify local evidence again and publish the immutable release receipt. New normal instances
can load the unchanged configured MCP permissions. No prompt, model run or test request is sent.

The receipt is the gate's commit point. Original leases and domain records are preserved; the original
quarantine and interruption checkpoint are archived before their coordination copies are removed.
`outcome: unknown` in both interruption and release history remains deliberate. Retries after a committed
release perform only matching archive cleanup, preserving any subsequently admitted work. An unconfirmed
instance-disposal response holds the gate and names the uncertain operation; it is never silently retried.
A crash before the receipt keeps quarantine active even if the pending deployment record already says
completed. Retrying that exact saved approval restores the drain and checks the bound evidence.

Before release, rollback means keeping the capable target restricted; it never boots the older unprotected
binary. After release, genuine work may start immediately. Any later rollback therefore requires a new
ordinary drain and quiet proof; the old observation approval cannot authorize another interruption.
