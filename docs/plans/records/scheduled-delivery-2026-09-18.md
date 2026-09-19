# Evaluation record: Scheduled delivery — 2026-09-18

Historical evidence appendix to [the evaluation plan](../evaluations.md), Phase 10.
This record separates scripted reliability tests, assistant inspection, local SMTP
capture and deployment configuration from real recipient receipt.

## Method and boundaries

Version 1 delivery adapter consumes the existing repository-brief v1 contract.
Nodemailer 10.0.10 composes/sends mail; smtp-server 3.19.13 supplies a local capture
listener. No new model prompts, capability authorities or GitHub mutations.

Test expectations were set around one analysis per occurrence, at most three SMTP
attempts, byte-identical retries, conservative unknown outcomes and no automatic
resend after ambiguity. Tests exercise real TCP SMTP acceptance/rejection/drop,
fault-injected storage failures, concurrent ticks and interrupted generation.
Fixtures use a scripted model only to produce a valid brief; they establish no
new task-quality evidence.

The live capture reuses the corrected P7 `get-bb/bb` brief, workflow
`39d5d436-66c9-4a19-ae9b-96a25dfd2909` (Copilot / gpt-5.6-terra). The user selected
daily 08:00 Eastern US time and authorized a local testing relay. Private recipient
configuration remains outside Git. Capture does not forward to the recipient.

## Results and evidence

- `npm run verify`: documentation checks, generated schemas, TypeScript and all
  **134 tests passed** (17 new delivery tests). `npm run demo` passed without
  subscription credentials. Tests cover DST gaps/folds, catch-up limits, config
  substitution, storage before/after SMTP, concurrency, retained crash locks,
  generation recovery, three-attempt bounds, reconciliation, real SMTP rejection
  and lost acknowledgement, and capture size/privacy limits.
- Installed capture trial: delivery workflow
  `754da689-e720-43b5-8e06-d5aed09c1b37`, one accepted SMTP attempt, one captured
  message. Repeating `send` retained one attempt and one capture. No new inference
  or GitHub collection was required.
- Prepared and captured MIME were byte-identical: 79,678 bytes; SHA-256
  `634efccbb20ce675850c7a1ada5b706a628d1ebf11d903153205c0d6bf43c519`.
  Assistant inspection via a MIME parser verified plain-text/HTML alternatives,
  configured recipient, original workflow provenance, and absence of raw agent
  state and broken relative artifact links. Mail-client rendering was not tested.
- User systemd units validated and enabled: `onionsoup-mail-capture.service` and
  `onionsoup-repo-brief.timer`, invoking `onionsoup-repo-brief.service`. The listener
  binds loopback port 2525 and never forwards. A manual service launch completed
  successfully as `not_due`, exercising the installed command/environment.
- Timer inspection showed its next occurrence as **2026-09-19 08:00 EDT**
  (12:00 UTC), using `America/New_York`. Configuration requests a rolling seven-day
  `get-bb/bb` brief with up to three suggestions, daily, with two-hour catch-up.
  Actual future unattended analysis remains unobserved at publication.

Private evidence is retained under `.local/delivery/`: operator configuration,
state ledger, frozen message and capture. Private service units reside in the
user's systemd directory. These files and the recipient address are not published.

## Limitations and next step

SMTP acceptance, local capture and recipient receipt are separate facts. This
trial does not qualify production deliverability, credentials, bounces or inbox
rendering. Configuring a daily timer does not prove a future unattended run.
The local capture service stops accepting messages at 100 retained captures; an
operator must archive them. The timer depends on this host's user manager and
respects a two-hour catch-up interval.

An initial relay test waited for an event emitted by the underlying TCP server,
not by the SMTP wrapper, and hung before sending. It was stopped and changed to
await the documented listen callback. No external message or model call occurred.

## References

- Plan phase: [evaluation Phase 10](../evaluations.md#phase-10--scheduled-delivery-reliability).
- Context: [packages and recipes](../../design/packages-and-recipes.md).
- Contract: [scheduled delivery](../../specs/scheduled-delivery.md).
- Rationale: [ADR-0011](../../adr/0011-separate-scheduled-analysis-from-mail-delivery.md).
- Prior task-quality evidence: [P7 brief trial](repository-brief-2026-09-18.md).
