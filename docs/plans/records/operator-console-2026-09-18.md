# Evaluation record: Operator console — 2026-09-18

Historical evidence appendix to [the evaluation plan](../evaluations.md), Phase 11.
Version 1 console/action records wrap the existing repository brief, scheduled
delivery and investigation packet contracts. No agent prompt or authority changed.

## Method and boundaries

Scripted tests exercise HTTP origin/CSRF boundaries, strict requests, stale config
and artifact hashes, duplicate IDs, per-selection deduplication, concurrent workers,
checkpoint failures, delivery retry eligibility, pause/resume, DST scheduling,
corrupt artifacts, path escapes and real Git source validation. They establish
software properties, not model task accuracy.

The local trial uses the corrected P7 `get-bb/bb` brief
`39d5d436-66c9-4a19-ae9b-96a25dfd2909`, existing capture-only delivery configuration,
and pinned source `3a4288bd0f34f888a5eb43f1099f7b60fe86eea4`. HTTP forms exercise
pause/resume and one selected issue at a time. Live model choice remains
Copilot / gpt-5.6-terra. No target code is executed and no GitHub writes occur.

## Results and evidence

- `npm run verify` passed: documentation, generated event schema, types and
  **148 tests**, including 13 console tests and an additional delivery precondition test. Scripted tests validate transport,
  persistence and dispatch properties, not semantic task accuracy.
- The installed loopback console serves the existing brief/delivery evidence and
  old issue inbox. Private job configuration fixes source, provider and delivery
  authority; the source selection does not come from the browser request.
- HTTP pause and resume completed and left scheduling enabled. Requests persisted
  action records. Duplicate forms returned the existing identity. Forged origin,
  host, CSRF, extra fields and stale configuration were rejected in tests.
- Corrected live selection: issue **#3926**, action
  `36770dc6-3611-451b-843d-98fb6b452baf`, packet
  `1cbdda12-301e-497e-9468-92b74ec54bb4`. Two Copilot/Terra agent invocations
  completed in 32.6 seconds (02:23:18.604–02:23:51.162 UTC on 2026-09-19).
  Readiness run: `0dfe84f1-fd4d-4ba5-af18-13d321535749`; location run:
  `e8aef66b-01b0-4788-bc38-5a718fbd515c`.
- The fresh issue was classified `bug_report / ready`. Location used eight bounded
  source inspections, returned three code pointers and two **adjacent** test
  pointers, and completed its bounded test search. All five quoted ranges were
  independently compared against pinned Git blobs and matched exactly.
- Assistant review found useful starting points in provider root composition,
  declaration and resolution. The packet correctly says the scan consumer was
  not inspected, the source pin differs from the reported commit, and intended
  declared-versus-resolved precedence remains uncertain. It does not claim a
  diagnosis, reproduction or correct repair.
- Repeating the same live form returned the same action and packet; the brief page
  then linked to the existing investigation. No additional model call occurred. `npm run demo` also completed without subscription credentials.
- SDK totals: readiness 2,913 input / 410 output tokens; location 65,615 input /
  1,792 output tokens, including 47,346 reported cache-read tokens. Billed cost
  and subscription quota remain unknown despite the provider's zero estimate.

Private records and HTTP proof are retained under `.local/console/`, with the
packet nested beneath its action. The user service `onionsoup-inbox.service`
keeps the console on loopback port 8765. The delivery timer and capture service
retain their prior configuration; this trial generated no additional email.

The initial live selection of issue #3905, action
`3301e039-05ce-452d-b368-954a838c2e12`, failed before source validation completed,
issue fetching or model invocation. An unbound static source helper lost its class
receiver. The host binding was fixed and a real-Git handoff regression test added.
The failed record remains visible; it was not overwritten or silently replayed.

## Limitations and next step

Browser automation reported no available browser. HTTP behavior, emitted HTML,
content policies and artifact links were inspected; no visual layout/accessibility
browser pass is claimed. Independent maintainer acceptance remains unmeasured.

The daily timer is configured, but its first unattended occurrence is still in the
future during this trial. Local SMTP capture is not Gmail forwarding or receipt.
The next proposed slice is a read-only change proposal; execution, patching and
PR publication remain separately gated in the [change workflow plan](../investigation-to-pr.md).

## References

- Plan phase: [evaluation Phase 11](../evaluations.md#phase-11--operator-console-and-explicit-handoff).
- Context: [console design](../../design/operator-console.md).
- Contract: [operator console](../../specs/operator-console.md).
- Rationale: [ADR-0012](../../adr/0012-operate-saved-workflows-through-a-local-console.md).
- Parent evidence: [P7 brief trial](repository-brief-2026-09-18.md),
  [P8 delivery trial](scheduled-delivery-2026-09-18.md).
