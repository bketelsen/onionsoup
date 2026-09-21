# Spec: Shared local job host

Chat and scheduled delivery invoke reviewed capabilities through one local service.
The generic host owns admission and lifecycle; registered domain functions retain
their existing evidence and effect contracts.

## Interface

Authenticated endpoints: `GET /v1/capabilities`, `POST /v1/jobs`,
`GET /v1/jobs/:id`, `POST /v1/jobs/:id/cancel`. Submission contains a capability ID,
typed input, an idempotency key, and optional correlation/parent job UUIDs.
Discovery returns only the invoker's capabilities, schemas, versions, effects and
limits. Job reads include bounded lifecycle events and a validated saved result.

Initial registry: `homelab.investigate`, `homelab.refresh`, `homelab.brief`, and
`repository.brief`. Inputs select configured targets, sources, repositories or
owned result IDs; they cannot select credentials, paths or commands. The chat
adapter projects shared results into the existing profile's evidence interface.
The delivery adapter saves the validated brief in the existing occurrence directory;
mail preparation and sending retain their existing ledger and reconciliation rules.

## Rules

- Bind only to IPv4 loopback. Require operator-generated bearer credentials on every
  endpoint; reject browser Origin headers. Credentials and private configuration stay
  outside Git and model context. Client redirects are disabled.
- Registry/configuration is fixed at launch. Invokers can submit, inspect and cancel
  their own jobs within explicit capability grants; there is no management API.
- Validate inputs before admission. Store the exact capability version/configuration
  binding, owner, input digest and optional parent/correlation identities. Reject a
  reused idempotency key with different input or identity. Identical retries return
  the original job and consume no additional admission.
- Persist reservations before execution. A single writer owns the state directory;
  a bounded queue runs one job at a time. Persist per-invoker lifetime admission
  counts across restart; failed/cancelled/interrupted jobs do not refund quota.
- Statuses distinguish queued, running, completed, failed, cancelled and interrupted.
  Completed means a validated capability artifact was produced; its own partial or
  failed assessment status remains visible and must not imply business success.
- Persist results before terminal completion. Persistence failure stops further
  admissions/execution. Restart marks unfinished attempts interrupted, without model
  calls or replay. A repeated idempotent request cannot restart an interrupted job.
- Cancellation and shutdown are cooperative. Local read/model effects only; no service
  mutation, GitHub publication, generic shell or email capability is introduced.
- Configuration changes cannot silently reinterpret the existing ledger. Operator
  recovery requires stopping the prior host before removing a stale lock.

## Configuration and operation

`npm run jobs -- --config /absolute/private/host.json` launches the compiled host.
Relative operator paths resolve beside the configuration file. Example:

```json
{
  "schemaVersion": 1,
  "directory": "state",
  "port": 8787,
  "capabilities": {
    "schemaVersion": 1,
    "provider": "copilot",
    "repositories": ["owner/repository"]
  },
  "invokers": [{
    "id": "schedule",
    "tokenFile": "schedule.token",
    "capabilities": ["repository.brief"],
    "maxJobs": 64
  }]
}
```

Generate independent random tokens for each invoker (at least 32 base64url
characters; 32 random bytes encoded as base64url is suitable). Store token files
with mode 0600 outside Git. The ledger never stores tokens or their hashes. Token
rotation with the same invoker identity preserves the ledger binding. Changing
grants, quotas, registry versions or capability configuration requires a deliberately
separate state directory; no migration or quota-reset API exists in this version.

Optional `capabilities.homelab` accepts the existing [homelab MCP configuration](workload-triage.md#persistent-chat-extensions).
Its source/target allowlists and configured observation files are reused. Its legacy
`runsDirectory` and `maxJobs` do not control the shared host: the service directory
and invoker quotas do. Model credentials belong to the service environment; the
chat parent also needs its own configured subscription. NAS collection uses the
service's external `TRUENAS_API_KEY`. This host does not load shell environment files.

```sh
npm run chat -- --host http://127.0.0.1:8787 \
  --token-file /absolute/private/chat.token --provider copilot
npm run delivery -- tick /absolute/private/delivery.json \
  --state /absolute/private/deliveries --host http://127.0.0.1:8787 \
  --token-file /absolute/private/schedule.token
```

Use a new chat session when switching between standalone MCP and shared hosting;
their bindings differ. Shared chat sessions bind the service configuration and
invoker identity, so a normal service restart retains their evidence references.
`--status` needs service discovery in remote mode but performs no model invocation.
The scheduled adapter checks provider agreement and attaches the delivery workflow
UUID as the shared job correlation ID. It saves a private `host-job.json` receipt
before and after submission, then saves the validated brief in the established
occurrence directory. External timers remain responsible for calling `tick`.

Generic requests are limited to 32 KiB of parsed capability input; result JSON to
8 MiB; the ledger to 32 MiB/500 total jobs. The queue permits sixteen outstanding
jobs and runs one at a time. Invoker admission limits are lifetime counts in this
ledger, not daily or monetary budgets. Capabilities retain their own smaller
context/model limits and have a cooperative deadline of at most 600 seconds.
Completed jobs can contain a partial/failed domain artifact, explicitly identified
inside the result. No automatic task retry follows either outcome.

This is a local pilot host, not a distributed queue. A crashed host requires manual
stale-lock recovery after verifying its process is gone. Unknown delivery-generation
outcomes remain `analysis_unfinished`; later ticks do not resubmit or automatically
copy a remote result after a crash. The receipt permits inspection and deliberate
operator recovery. A new idempotency key is a new authorized attempt and costs
another admission; the old interrupted attempt is never rewritten as successful.

## References

- Rationale: [ADR-0029](../adr/0029-host-reviewed-capabilities-through-a-shared-job-api.md).
- Context: [composition design](../design/packages-and-recipes.md).
- Consumers: [chat](chat.md), [scheduled delivery](scheduled-delivery.md).
- Domain contracts: [workload triage](workload-triage.md), [repository brief](repository-brief.md).
- Evidence: [shared-host qualification](../plans/records/shared-host-2026-09-21.md).
- Work: [roadmap](../plans/roadmap.md), [evaluation plan](../plans/evaluations.md).
