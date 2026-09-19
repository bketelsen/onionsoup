# Spec: Scheduled repository-brief delivery, version 1

This contract governs a single-host schedule adapter and SMTP delivery of a saved
[repository brief](repository-brief.md). Host configuration authorizes the recipient
and transport. Agents have no email tools. Implementation:
[runtime](../../src/delivery/runtime.ts), [schemas](../../src/delivery/contracts.ts).

## Interface

```sh
# Use a private copy of examples/delivery/config.json.
npm run mail-capture -- .local/mail-capture --port 2525
npm run delivery -- tick .local/delivery.json
npm run delivery -- prepare .local/delivery.json runs/repository-briefs/EXAMPLE/repository-brief.json
npm run delivery -- send .local/delivery.json OCCURRENCE
npm run delivery -- inspect .local/delivery.json OCCURRENCE
npm run delivery -- reconcile .local/delivery.json OCCURRENCE accepted --evidence 'relay journal reference'
```

All delivery commands accept `--state DIRECTORY` (default `runs/deliveries`).
`prepare` never sends or invokes analysis. `send` admits the first send or an explicit
retry of a rejected/confirmed-unaccepted attempt. `reconcile` accepts `accepted` or
`not_accepted` and requires a nonempty operator evidence reference, up to 500
characters. This is a recorded operator assertion, not automatic proof of absence.
`inspect` is read-only. Commands report safe metadata; failure diagnostics omit raw
transport/provider errors. Unknown/rejected/unfinished/failed analysis exit nonzero.

The strict [example configuration](../../examples/delivery/config.json) supplies:

| Field | Required constraints |
| --- | --- |
| `schemaVersion`, `jobId` | Version 1; stable lowercase alphanumeric/hyphen ID, 1–64 characters |
| `repository`, `provider` | Valid owner/repository; explicit `copilot` or `codex`, current model Terra |
| `days`, `maxSuggestions` | Rolling activity window 1–90 days; 0–10 proposals |
| `schedule` | IANA `timeZone`, `HH:MM` wall time, unique `weekdays` 0=Sunday through 6=Saturday, `catchUpHours` 1–24 |
| `from`, `to` | One ASCII mailbox each; no address lists, display names or control characters |
| `smtp` | Host, port, `security`: `tls`, `starttls`, or `loopback`; optional `auth` with `userEnv`/`passwordEnv` variable names |

Credential values MUST NOT be stored in the configuration. TLS modes require valid
certificates; plaintext requires explicit `loopback`, literal `127.0.0.1` or `::1`,
and no authentication. A transport change is a configuration change. `.invalid`
addresses in the example are placeholders suitable only for capture tests.

## Rules

- A one-shot `tick` finds only the latest scheduled local minute within catch-up.
  Weekdays are evaluated in the configured zone. A spring-forward skipped minute
  has no occurrence; a fall-back repeated minute uses its first UTC instant and
  one local identity. Older missed occurrences are skipped, never queued in bulk.
- Occurrence identity is local `YYYY-MM-DDTHH:MM`; the directory name hashes job ID
  and occurrence. On-demand preparation uses `manual-BRIEF_WORKFLOW_UUID`. The
  ledger freezes the parsed configuration hash; changing configuration for an
  existing occurrence MUST stop. A deliberate new job ID creates a new identity
  and can send another copy, so do not change IDs to bypass an uncertain result.
- Scheduled request windows end at the due instant, even when the worker runs
  later. Backlog counts remain current at collection. Each occurrence records
  intent before at most one repository analysis (four agent admissions).
- The host freezes validated completed/partial briefs, their workflow ID/hash,
  and MIME bytes before sending. Partial reports preserve their visible limitations.
  Failed analysis is not mailed. An interrupted analysis is never automatically
  rerun; recovery can adopt an already saved completed/partial result.
- Each occurrence allows at most three SMTP attempts. Every attempt's `sending`
  intent MUST be saved before invoking SMTP. An accepted result means SMTP
  acceptance only, not mailbox delivery. Definite SMTP 4xx/5xx rejections permit
  explicit retry; ticks do not retry them. Other exceptions, deadline expiry, or a
  persisted unfinished send are unknown and cannot retry without reconciliation.
- Retries reuse exact frozen MIME bytes, Message-ID and destination configuration.
  Artifact hash/request mismatches MUST stop. Message-ID is correlation, not
  destination-supported idempotency. No exactly-once guarantee is made.
- Reconciliation requires the previous sender to have stopped and operator evidence
  of acceptance/nonacceptance. It records the original uncertain attempt plus the
  resolution. Absence of a local success record is not evidence of nonacceptance.
- Exclusive `.lock` directories serialize all occurrence mutations on one local
  filesystem. A crash-held lock is never stolen. Stop/check workers first, inspect
  the ledger and relay logs, then remove only that occurrence's `.lock` directory
  manually. A subsequent tick/send can reuse saved analysis, but an unfinished
  SMTP attempt still requires reconciliation. Do not delete ledgers as recovery.
- SMTP connection/greeting/DNS bounds are 10 seconds, socket idle bound 30 seconds,
  and observed attempt deadline 60 seconds. Deadline expiry remains unknown, even
  if a transport closes slowly. Analysis retains its existing 600-second bound.
- Ledgers/messages use mode 0600 and created directories 0700. Checkpoints use
  atomic rename; no power-loss, distributed-filesystem or hostile-local-user
  guarantee is made. Preserve the state directory across process restarts.

### Capture relay

`mail-capture` binds only `127.0.0.1`. It uses `smtp-server` to save `.eml` files
before acknowledging acceptance, with no forwarding or MX lookup path. It disables
SMTP authentication, STARTTLS and reverse lookup, permits five clients, limits
messages to 10 MiB and retains at most 100 messages. A full/failed capture store
rejects further mail. Archive captures deliberately to reclaim capacity. This is
an unauthenticated local development sink, not a production mail server. A local
process can submit mail to it; capture contents must still be treated as untrusted.

### Operating a daily capture schedule

Use an external scheduler to invoke the CLI. For systemd user services, set an
absolute `WorkingDirectory`, `ExecStart` (Node with `--import tsx`), state/config
paths, and a PATH that includes authenticated `gh`. Configure subscription access
via `ONIONSOUP_AUTH_PATH` outside Git. Set `UMask=0077` and a start timeout longer
than analysis plus SMTP (for example 12 minutes). Keep credentials out of unit text.

A timer can use `OnCalendar=*-*-* 08:00:00 America/New_York`, `Persistent=true`, and
`AccuracySec=1min`. Start the capture service before the tick service. Catch-up
still applies: a machine returning after the configured interval skips that day.
User timers depend on the user manager running; they do not wake a powered-off
machine. Keep the capture listener and state on the same host. Stop the timer to
pause new analyses; stopping/removing it does not erase delivery history.

To switch to real mail, choose a permitted sender and authenticated TLS service,
configure credential environment references privately, and deliberately use a new
job ID for future occurrences. Do not replay already accepted capture occurrences
as though they were failed SMTP sends. Production authentication, deliverability,
bounces and recipient receipt remain separate operational qualification.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| `delivery.json` | Version 1 ledger: UUID, job/occurrence/config binding, request, saved brief and MIME hashes, up to three attempts/resolutions |
| `analysis/` | Original recipe outputs, if generated by the schedule |
| `brief.json`, `message.eml` | Frozen validated brief and MIME projection; mail contains prose/metrics/provenance, not raw agent state |
| `events.json` | [Common derived trace](agent-discovery.md) without recipient, SMTP host, body, credentials or reconciliation text |

Mail contains plain text and HTML, preserves evidence links, removes relative
local-artifact links, and names the saved analysis workflow. Event types add
`delivery.prepared/attempted/accepted/rejected/unknown/reconciled`, optional
`deliveryAttempt` (1–3), `deliveryResolution`, parent brief identity and message
hash. Ordering follows persisted attempt history; an unfinished attempt exports
unknown at its original start time. The ledger remains authoritative if writing
its derived event projection fails; `inspect` regenerates events without effects.

## References

- Rationale: [ADR-0011](../adr/0011-separate-scheduled-analysis-from-mail-delivery.md).
- Context: [packages and recipes](../design/packages-and-recipes.md).
- Implementation phase: [backlog P8](../plans/backlog.md#phase-8--scheduled-delivery).
- Evidence: [delivery trial](../plans/records/scheduled-delivery-2026-09-18.md).
- Transport APIs: [Nodemailer SMTP](https://nodemailer.com/smtp),
  [SMTP server](https://nodemailer.com/extras/smtp-server).

### Operator console additions

[ADR-0012](../adr/0012-operate-saved-workflows-through-a-local-console.md) and the
[console contract](operator-console.md) add `ondemand-UUID` occurrence identities,
`runNow(config, requestId, options)`, a persisted schedule pause flag under the
shared delivery state directory, and an optional expected-attempt precondition
checked inside the delivery lock. Historical v1 records remain readable. Paused
ticks return `paused` without analysis/send; explicit run-now remains available.
The external timer continues to run and observe the flag. These are host controls,
not new agent permissions. See [console design](../design/operator-console.md).

Packaging and host composition follow [ADR-0022](../adr/0022-package-capabilities-with-thin-host-applications.md)
and the [workspace package contract](workspace-packages.md).
