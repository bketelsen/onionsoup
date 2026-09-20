# Spec: Read-only TrueNAS evidence

This contract governs `@onionsoup/truenas-source` and `apps/homelab-cli`. It collects
one configured NAS snapshot through an existing local MCP server, without model
calls, remote mutation or changes to the server project.

## Interface

`collectTrueNasHealth(target, {apiKey, directory, signal?})` saves admission and
returns a `TrueNasRun`. `normalizeTrueNasHealth(report)` is a pure projection of
the upstream report into `TrueNasEvidence`; the upstream summary is not authoritative.
Schemas and validators are exported from the package's public entrypoint.

```json
{
  "schemaVersion": 1,
  "assetId": "nas-primary",
  "binary": "/absolute/path/to/truenas-mcp",
  "host": "nas.example.invalid",
  "tlsInsecure": false
}
```

The strict target schema rejects credentials, arbitrary arguments, write flags and
extra fields. `assetId` is a local operator-selected identifier. The executable
must be an absolute path to an operator-trusted binary; the adapter records its
SHA-256 digest and a digest of the complete target configuration. The credential
is supplied separately through `TRUENAS_API_KEY` and never hashed or persisted.

```sh
# Load credentials using the existing server's operator-managed configuration.
# Keep shell tracing disabled; never place the key on the command line.
set +x
source /absolute/path/to/truenas-mcp/.envrc
npm run homelab -- truenas /absolute/path/to/target.json
# Or use compiled workspaces after npm run build:
node apps/homelab-cli/dist/main.js truenas /absolute/path/to/target.json
```

Default outputs use a new directory beneath ignored `runs/homelab/`.
`--output NEW_DIRECTORY` selects an exclusive directory; existing paths are rejected.
Host configuration and credentials are local, not inputs from a model or remote tool.
The binary stays separately installed: it is not vendored into Onionsoup.

### Saved observation

`observation.json` contains version/kind, run identity, asset identity, target/binary
digests, start/finish timestamps, read-only/TLS mode, bounded discovered tool names,
status, and either normalized evidence or a generic failure category.

| Field | Meaning |
| --- | --- |
| `coverage` | Whether each of system, system state, pools, disks and alerts supplied usable data |
| `state` | `READY`, `BOOTING`, `SHUTTING_DOWN`, `other`, or null when unavailable |
| `pools` | Reported pool count, flagged count and count with insufficient health fields; null when unavailable |
| `disks` | Reported inventory count only; null when unavailable |
| `alerts` | Count, dismissed count and counts by severity, including unknown severities |
| `disposition` | `no_flags_observed`, `attention_required`, or `unknown`; not an exhaustive health grade |

Pool flags include explicit unhealthy/warning flags or a non-ONLINE status. A pool
without positive healthy, false warning and ONLINE evidence remains unknown.
Alert severities EMERGENCY, ALERT, CRITICAL, ERROR, WARNING and WARN are flags.
Non-READY system state is also a flag. Flags take precedence over missing coverage;
otherwise any unavailable section or unknown pool/severity prevents a clear result.
Counts include dismissed alerts; the dismissed count remains explicit. A disk
inventory entry establishes neither SMART health nor the absence of hardware faults.

`completed` means every section supplied usable data, independently of health flags.
`partial` means normalized evidence exists with missing or malformed sections.
`failed` means connection, catalog, collection, format, cancellation or deadline
prevented a usable observation. A persisted `running` record after interruption is
unfinished evidence, never success. No automatic resume or retry is supported.

## Rules

- The child MUST receive `--enable-writes=false` and `TRUENAS_ENABLE_WRITES=false`.
  The key travels only in its environment. Stdout is the MCP protocol; child stderr
  is drained without recording or forwarding it.
- `tlsInsecure` defaults false. Explicit true passes the server's scoped TLS flag;
  no global Node TLS setting, trust-store change or other-host exception is made.
- Discovery MUST identify `truenas-mcp`, contain the health tool, have no further
  page, duplicates or unreviewed names. Only the reviewed 18 read-tool names are
  allowed. Additional tools require code review; tool descriptions do not grant authority.
- The adapter MUST invoke only `truenas_health_report` with `{}`. It does not invoke
  app configuration or other read tools merely because they are discoverable.
- Admission MUST be saved before process launch; accepted discovery MUST be saved
  before the tool call. Storage failure stops work; partial upstream errors remain unknown.
- Limits: 45-second cooperative observation deadline, 15-second initialization,
  10-second discovery, 25-second tool call, one call and no retry. Close the child on
  cancellation. Upstream internal WebSocket calls are owned by the existing server.
- The tool result must contain one text JSON block, at most 2 MiB after receipt.
  Each normalized resource array is limited to 5,000 entries. This is not an OS-level
  child memory or message-stream sandbox; the local executable is trusted host code.
- Never persist raw tool results, alert prose, serials, topology, host address,
  app configuration, API keys or upstream errors. JSON artifacts use mode 0600
  inside an exclusive mode-0700 directory. API failures do not become zero counts.
- No model calls, NAS writes, app control, credential copying or global MCP-client
  registration occur in this phase. The library is an evidence source for later agents.

## Derived artifacts

- The source adapter and CLI compile with the existing workspace build.
- Repository-brief releases include their application dependency closure only;
  adding this independent homelab workspace does not bundle it into an OSS app.
- Historical/local evidence is separate from public source; private observations
  are not copied into documentation or fixtures.

## References

- Rationale: [ADR-0023](../adr/0023-collect-read-only-truenas-evidence-through-existing-mcp.md).
- Context: [package design](../design/packages-and-recipes.md),
  [workspace contract](workspace-packages.md).
- Delivery: [roadmap phase 22](../plans/roadmap.md#phase-22--read-only-truenas-evidence).
- Evidence: [TrueNAS first contact](../plans/records/truenas-first-contact-2026-09-19.md).
