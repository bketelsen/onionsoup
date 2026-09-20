# Spec: Workspace packages and repository-brief hosts

This contract governs the first deployable slice of Onionsoup: reusable repository
analysis, the brief recipe, scheduled delivery, and CLI/MCP consumers. Existing
readiness, location and implementation workflows remain in the legacy application.

## Interface

| Workspace | Responsibility |
| --- | --- |
| `@onionsoup/runtime` | Atomic JSON storage, budget, event schemas, inert text escaping, host-only bounded SSH |
| `@onionsoup/providers` | Explicit Copilot/Codex selection and the Terra evaluation policy |
| `@onionsoup/repository-analysis` | Three focused agents, schemas, collection, metrics and manifests |
| `@onionsoup/repository-brief` | Four-stage recipe, records, rendering and its event projection |
| `@onionsoup/brief-delivery` | Existing scheduled occurrence ledger, locks, SMTP and local capture |
| `@onionsoup/brief-mcp` | Bounded application jobs exposed through MCP tools |
| `apps/brief-cli` | On-demand brief creation and offline rendering |
| `apps/brief-worker` | One-shot scheduled delivery commands for an external timer |
| `apps/brief-mcp` | Local stdio MCP host with exclusive run-directory ownership |
| `apps/mail-capture` | Development loopback SMTP capture, with no forwarding |

Every package has explicit exports and declared dependencies. Source selection uses
`--conditions=onionsoup-source --import tsx`; default exports resolve compiled ESM.
Root npm commands select source during development. `npm run build` compiles all
workspaces. The repository-brief release selects its four apps and their transitive
workspace dependencies, excluding unrelated hosts such as the [homelab CLI](truenas-evidence.md). `npm run check:packages` rejects escaping imports, undeclared runtime
dependencies, private workspace paths, application dependencies and cycles.

### Portable release

```sh
npm ci
npm run verify
npm run release:brief
# Copy dist/repository-brief to the deployment directory, then there:
npm ci --omit=dev --ignore-scripts
node verify-release.mjs
npm run brief -- OWNER/REPO --days 7
npm run worker -- tick /absolute/config.json --state /absolute/state
```

Node 24+ is required. Live collection also requires authenticated `gh` on PATH,
and model calls require the configured Copilot/Codex subscription. Set
`ONIONSOUP_AUTH_PATH` to an external auth file. The release contains compiled ESM,
declarations, workspace manifests, the lockfile and a SHA-256 file inventory;
no TypeScript sources, legacy application, tests, credentials or raw runs are copied.
The inventory records build Node version, source revision and dirty-worktree status.
It detects changes against that inventory; it is **not** a signed attestation and
cannot defend against replacement of both files and inventory. Dependency versions
and integrity are governed by `npm ci` and the lockfile, not the code inventory.

The existing Node repair dependency provisioner accepts registry-only lockfiles;
workspace-target patch execution is not yet qualified. Historical sandbox trials
remain pinned to their original source and dependency snapshots. This package
extraction does not extend the repair adapter's accepted dependency policy.

Keep state/configuration outside the release. An external timer invokes `worker
-- tick`; the app does not create a timer. Existing schedule, recipient, SMTP,
retry and reconciliation rules remain the [delivery contract](scheduled-delivery.md).
The development relay remains local-only; this phase does not enable external mail.

### Repository-brief MCP

Launch `node /absolute/release/apps/brief-mcp/dist/main.js` from an MCP client with:

| Environment | Meaning |
| --- | --- |
| `ONIONSOUP_PROVIDER` | Required `copilot` or `codex`; recipe uses Terra |
| `ONIONSOUP_REPOSITORIES` | Required comma-separated allowlist, 1–100 entries |
| `ONIONSOUP_RUNS_DIR` | Required absolute or host-resolved directory for saved jobs |
| `ONIONSOUP_MAX_JOBS` | Optional per-process admission allowance, 1–10; default 1 |
| `ONIONSOUP_AUTH_PATH` | Optional provider auth path, managed outside requests |

The four tools are application-level tools, not the optional MCP Tasks protocol:

| Tool | Strict input | Result |
| --- | --- | --- |
| `discover_repository_brief` | `{}` | Allowed repositories, capability manifests, admission state, limits and effects |
| `submit_repository_brief` | `{request: BriefRequest}` | `{schemaVersion:1, jobId, status:"admitted"}` |
| `inspect_repository_brief` | `{jobId: UUID}` | Saved lifecycle, result status, budget, rendered Markdown and event export |
| `cancel_repository_brief` | `{jobId: UUID}` | Cooperative cancellation request for a currently active job |

A submit returns without waiting for inference. Inspection statuses are `running`,
`settled`, `execution_failed`, or `unfinished`. `settled` means the recipe returned;
its separate `resultStatus` may still be failed or partial. A known admission left
without termination after restart is `unfinished`. Inspecting it does not replay it.
A new submission is a deliberate new attempt, with a new ID and budget; no request
deduplication or exactly-once claim is made. Job inspection persists across restarts,
but process admission limits reset on restart. There is no distributed queue.

## Rules

- Packages MUST NOT import root `src/` or application code. Cross-package imports
  MUST use declared public exports. Agents receive no transport-specific authority.
- Prompts, request/result schemas and record versions MUST remain unchanged by
  extraction. The three analysis capability manifests advance to version 2 to
  advertise package imports; v1 records and compatibility forwarding modules remain.
- CLI, worker and MCP MUST invoke the same brief recipe. MCP MUST NOT expose mail,
  shell execution, target-code execution, GitHub mutation or arbitrary filesystem access.
- MCP validates repository allowlisting and a nonfuture window before reservation.
  Caller input cannot choose providers, models, paths, commands or recipients.
- Only one job may run per host. Reserve process allowance before storage awaits;
  persist admission before any API/model work. Storage failure spends admission
  conservatively and MUST NOT begin collection.
- Each recipe retains its four-model-call allowance, 20-request collection bound
  and ten-minute timeout. Cancellation is cooperative and never restores allowance.
- Inspection MUST bind saved request and provider to the admission. Raw model state,
  credentials, error text and local paths MUST NOT be returned to the MCP caller.
- The stdio app exclusively locks its run directory. Clean shutdown releases the
  lock after cancellation; after a crash an operator verifies that the old process
  is gone before removing `.host-lock`. The library requires one owner per directory.
- `npm run verify` checks docs, boundaries, generated capabilities, types and tests.
  `ONIONSOUP_RELEASE_INSTALL=1 npm test` additionally installs and exercises the
  compiled release in a fresh temporary directory with no source-tree dependency.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| `packages/*/dist`, `apps/*/dist` | TypeScript 5.9 compilation with relative extension rewriting |
| `dist/repository-brief/release.json` | SHA-256 inventory of compiled workspaces, manifests, lock and verifier |
| `capabilities/*.json` | Existing generator uses packaged analysis manifests |
| MCP job directory | Admission `job.json`, recipe artifacts beneath `analysis/` |

## References

- Rationale: [ADR-0022](../adr/0022-package-capabilities-with-thin-host-applications.md).
- Context: [packages and recipes](../design/packages-and-recipes.md),
  [repository layout](../design/repository-layout.md).
- Contracts: [repository brief](repository-brief.md), [scheduled delivery](scheduled-delivery.md),
  [events and discovery](agent-discovery.md). The [original MCP adapter](mcp-adapter.md)
  remains a separate command and authority surface.
- Delivery: [roadmap phase 21](../plans/roadmap.md#phase-21--reusable-packages-and-thin-applications).
- Protocol context: [MCP server concepts](https://modelcontextprotocol.io/docs/learn/server-concepts).


## Chat consumer packages

Under [ADR-0028](../adr/0028-separate-chat-sessions-from-domain-capabilities.md),
`@onionsoup/chat` owns session/turn execution without MCP or homelab imports.
`@onionsoup/homelab-chat` supplies reviewed domain tools and evidence validation;
`apps/chat-cli` supplies terminal input and the fixed local MCP connection. See the
[chat contract](chat.md) and [phase 27](../plans/roadmap.md#phase-27--persistent-chat-and-homelab-profile).
The OSS brief release still excludes these homelab consumer workspaces.
