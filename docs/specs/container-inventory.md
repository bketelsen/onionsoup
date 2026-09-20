# Spec: Container inventory over SSH

`@onionsoup/container-source` produces a bounded, deterministic inventory snapshot
for one operator-configured host. The existing homelab CLI consumes the same callable
function. It is an evidence adapter, not a model-driven shell or repair agent.

## Interface

```json
{
  "schemaVersion": 1,
  "assetId": "compute-primary",
  "host": "compute.example.invalid",
  "user": "observer",
  "port": 22,
  "engines": ["docker", "podman", "incus"]
}
```

`host` is a direct DNS name or IPv4 address; `user` is explicit. Port defaults to 22
and engines default to all three. Strict validation rejects arbitrary SSH options,
commands, identity paths, sudo, duplicate engines and extra fields. Keep real target
configuration in ignored local storage. Keys and SSH-agent credentials stay external.

```sh
npm run homelab -- containers /absolute/path/to/target.json
npm run homelab -- containers /absolute/path/to/target.json --output /new/directory
# After npm run build:
node apps/homelab-cli/dist/main.js containers /absolute/path/to/target.json
```

`collectContainerInventory(target, {directory, signal?, transport?})` is the public
function. `transport` is a trusted host integration/test seam, not caller-supplied
command text. Default output directories are new entries under ignored `runs/homelab/`.
Existing directories are rejected; saved observations use mode 0600 in mode-0700
folders. Neither SSH targets nor resource names are copied into the observation.

### Fixed command scopes

| Engine | Fixed observation | Coverage |
| --- | --- | --- |
| Docker | `docker --host unix:///var/run/docker.sock ps --all --format '{{json .State}}'` | Standard local daemon socket; not every rootless/context daemon |
| Podman | `podman --remote=false ps --all --format '{{json .State}}'` | Storage visible to the SSH user; no sudo or other-user enumeration |
| Incus | `incus --force-local list --all-projects --format csv --columns s` | Local daemon's visible projects; a cluster view may span physical members |

Executables are fixed to `/usr/bin/`; an executable-path precheck returns an explicit
unavailable category. Relevant engine remote/context environment overrides are
removed. Commands request states only, excluding names, image URLs, ports, labels,
configuration, command lines, mounts and environment variables. Incus's CSV projection
avoids collecting its full instance JSON, which can contain configuration secrets.
Do not sum different hosts' Incus views as unique physical workloads without a future
identity/deduplication contract.

### Observation semantics

`observation.json` has version 1 and kind `container-inventory`, a run ID, asset ID,
normalized target digest, command version `ssh-container-states-v1`, timestamps and
one ordered query per selected engine. Each query records its scope, command digest,
status, timestamps and either normalized state counts or a generic failure category.

- `collected`: a successful query produced valid output, including a valid empty list.
  State counts partition the reported total. Future unrecognized state tokens become
  `unknown`; their original text is discarded.
- `unavailable`: the fixed CLI path was absent or not executable; there are no counts.
- `failed`: SSH, execution, timeout, cancellation, output-limit or format failure;
  there are no fabricated zero counts or partial parsed rows.
- `not_attempted`: cancellation or the overall deadline prevented admission.
- `pending`/`running`: persisted work without completion is unfinished, not success.

Run status is `completed` when all selected queries collected, `partial` when some
collected, and `failed` when none collected. Query health and application health are
separate: running does not prove healthy; stopped/exited does not prove an incident.
CLI exit is zero for completed acquisition, one for partial/failed acquisition.

## Rules

- Persist run admission before contact and query admission before each SSH process.
  Stop immediately on persistence failure. No retries or automatic resume occur.
- Local execution MUST use `/usr/bin/ssh` with argument arrays and fixed remote
  command strings. No validated target field is interpolated into shell text.
- Use standard existing keys/SSH-agent and host-key databases. Force batch mode,
  strict host-key checking, no host-key updates, no TTY, no agent/X11/port forwarding,
  no local command hooks or multiplexed connection reuse. `-F /dev/null` intentionally
  bypasses client configuration: proxy hops, aliases and custom identity files are
  not part of this initial contract. Never accept unknown host keys automatically.
- The local child inherits only PATH, HOME and SSH_AUTH_SOCK. Raw stderr is counted
  toward the output bound but discarded. Raw stdout remains transient and is never
  persisted; only normalized enum counts are saved.
- Bound each SSH process to 20 seconds, connect to eight seconds, and the whole
  observation to 65 seconds. At most three sequential queries may run. Combined
  stdout/stderr is limited to 256 KiB per process; each inventory is limited to 5,000
  rows. Kill the local SSH process on cancellation, timeout or overflow. Remote
  teardown still depends on SSH/CLI behavior; no remote mutation is requested.
- Missing tools, authentication/host-key failures and inaccessible daemons MUST stay
  distinguishable from a successful empty inventory. Generic failure codes preserve
  uncertainty without exposing upstream diagnostics.
- The adapter installs nothing, changes no host configuration, invokes no sudo,
  launches/stops/deletes no workload, and makes no model calls. The account may have
  broader privileges: a read-only command set is not a server-side authorization role.
  A future restricted SSH key/forced-command helper can narrow server-side authority.

## Derived artifacts

The package and CLI compile with the workspace build. The repository-brief release
excludes the homelab app and both independent homelab source packages. Private live
observations and target files stay out of Git; public tests use synthetic states.

## References

- Rationale: [ADR-0024](../adr/0024-collect-container-inventory-over-bounded-ssh.md).
- Context: [package design](../design/packages-and-recipes.md),
  [workspace contract](workspace-packages.md), [TrueNAS source](truenas-evidence.md).
- Delivery: [roadmap phase 23](../plans/roadmap.md#phase-23--ssh-container-inventory).
- Evidence: [SSH inventory pilot](../plans/records/container-inventory-2026-09-19.md).
- CLI sources: [Docker list](https://docs.docker.com/reference/cli/docker/container/ls/),
  [Podman ps](https://docs.podman.io/en/latest/markdown/podman-ps.1.html),
  [Incus list](https://linuxcontainers.org/incus/docs/main/reference/manpages/incus/list/).
