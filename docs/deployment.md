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

Staged `npm run verify` always skips exactly the named test
`a sandboxed npm ci succeeds in a minimal fixture, with private XDG roots and the worktree writable`:
it needs a host user bus to start a nested sandbox, and the isolated release stage has no host bus.
The stage prints this exception when verifying. It does not depend on `ONIONSOUP_DEPLOY_E2E`
(which only opts into the outer real-archive test); ordinary `npm run verify` still runs that test.

The drain stops new admitted turns and requires all live leases to finish. The worker reads
`/session/status`, `/permission`, and `/question` for every declared owner chat/desk, operator
directory and recorded plan/session directory; missing, malformed or unreadable responses hold
the gate. It rejects another same-user opencode process detected through `/proc`. After a
five-second quiet interval it probes every second, and rechecks just before the atomic pointer switch.
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
