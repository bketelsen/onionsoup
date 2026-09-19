# Evaluation record: On-demand maintenance briefing — 2026-09-18

Historical evidence appendix to [the evaluation plan](../evaluations.md), completing
[backlog P6](../backlog.md#phase-6--on-demand-maintenance-briefing). Review was by the
assistant: integration checks, exact-source verification and qualitative reading.
No independent maintainer grading or broad accuracy estimate is claimed.

## Method and boundaries

Run the actual briefing CLI once against `get-bb/bb` with default bounded intake:
inspect 100 recently updated API entries, select the first five valid open issues,
and pin the existing checkout's HEAD. The pinned commit was
`3a4288bd0f34f888a5eb43f1099f7b60fe86eea4`. No source fetching or target code execution.
The seven-attempt allowance admits five readiness runs then at most two location
runs, selected by captured order. No model-powered outer coordinator is involved.

Both agents use Copilot `gpt-5.6-terra`, AgentLayer 0.0.36, unchanged prompts
`bug-readiness-v4` and `code-location-v7`, readiness input/result v1/v2 and location
input/result v1/v3. Root briefing, readiness workflow and location handoff are v1.
The source runtime hash is
`b52c41380f58cc540f69a2b90e07d841499e1fc9a1689f84ff70ebd5c34cce6d`.
A private pre-run plan froze hashes of all `src/*.ts` and `package-lock.json`:
aggregate SHA-256 `6a06483e31a0f72498bffcbdb11372b3dc5067d43c1598ea200628ff034164d2`.
These hashes matched after execution. A later presentation-only change added an
at-a-glance table, then regenerated the report without inference or record changes.

Before execution, expectations were exact input preservation, sequential shared
reservations, first-two eligibility selection, grounded citations, neutral feature
classification, no retries or writes, and honest partial outcomes. This was an
operational development trial, not a frozen labeled accuracy dataset.

## Results and evidence

One live attempt completed: root workflow
`83cb52b0-33a8-450e-a240-3b0f9a149633`, stored under ignored local
`runs/briefings/p6-live-2026-09-18/`. Original UTC timestamps were
`2026-09-19T00:39:07.349Z` to `2026-09-19T00:40:18.102Z` (70.753 seconds).
The report's date uses local America/New_York time.

| Issue | Readiness result | Location outcome |
| --- | --- | --- |
| #3921 reduced-motion spinner | Ready bug | Located code and one adjacent test excerpt |
| #3911 custom llama-server initialization | Needs information | Ineligible; asks for bb/Pi version and OS/runtime |
| #3912 per-thread token/cost display | Feature request; not applicable | Ineligible; no acceptance decision |
| #3773 macOS artifact endpoint failure | Ready bug | Located code and two adjacent test excerpts |
| #3337 OAuth expiry handling | Ready bug | Explicit selection-limit skip after two earlier ready reports |

All five original snapshots match child inputs exactly. Intake rejected none;
six comments were excluded and counted, not read. Seven reservations consumed
exactly the shared allowance. The 115-event trace retains the root, three child
workflow identities, seven new agent starts, and historical readiness references
inside the two handoffs without double-counting usage. All raw records and model
prose remain private; the common trace contains only allowlisted metadata.

All seven citations were matched independently against pinned Git blobs:

| Issue | Source window | Meaning / limit |
| --- | --- | --- |
| #3921 | `apps/app/src/components/thread/ThreadStatusGlyph.tsx:232–243` | Runtime spinner class |
| #3921 | `apps/app/src/components/sidebar/ThreadRow.tsx:217–235` | Runtime-active glyph call site |
| #3921 | `apps/app/src/components/sidebar/ThreadRow.test.tsx:549–572` | Adjacent animation-class assertion; no reduced-motion/collapsed-sidebar scenario |
| #3773 | `apps/server/src/services/install/bb-app-artifact.ts:270–289` | Artifact command invocation |
| #3773 | Same file, `67–76` | Default command runner |
| #3773 | `apps/server/test/app/bb-app-artifact.test.ts:188–217` | Adjacent successful packaging test |
| #3773 | Same file, `233–255` | Adjacent output assertions; no restricted-PATH or npm ENOENT scenario |

Assistant review found useful reading starting points and no claimed diagnosis or
fix. Both runs explicitly note source/report revision differences. The artifact
report leaves the HTTP route-to-builder chain unverified. The spinner report does
not claim to establish computed CSS, offscreen mounting, or renderer load. All
three suggested test excerpts are correctly limited to adjacent evidence in this
review. The missing-version question on #3911 fits the supplied snapshot; comments
and linked reports might contain additional context that was outside intake.

The actual `render` command regenerated Markdown and events without inference;
the generic event CLI produced the same trace. Nine new software tests cover the
seven-attempt limit, ordering and capacity skips, exact identity validation,
intake rejection, private artifact modes, inert Markdown, exclusive output,
source/intake failures, cancellation before and during work, adapter failure,
storage boundaries, and model-free rendering. **102 tests pass**, along with
types, documentation checks, generated-schema checks and the credential-free demo.
Scripted tests establish these runtime properties, not task accuracy.

## Limitations and next step

The default scan is a bounded recent window and may include fewer than five open
issues; it does not ensure coverage or prioritize severity. This trial's larger
reports include contributor-supplied source hints, so it does not establish code
search performance on sparse reports. A completed bounded test search does not
mean all relevant tests were found. Target tests were never executed.

The checkout is operator-owned and can differ from the report's revision. Billed
cost and remaining subscription quota are unknown. Copilot was exercised here;
Codex remains available but was not exercised by this command. There is no
scheduler, resume, automatic retry, durable cross-process quota, or write authority.

P6 supplies a practical reusable recipe without adding another agent. A next
separate-domain proof could assess supplied homelab backup evidence against an
explicit policy. That would require its own task contract and authorized inputs,
following the [broader roadmap vision](../roadmap.md#broader-vision--domain-focused-agent-teams).

## References

- Plan phase: [evaluation plan — Phase 8](../evaluations.md#phase-8--on-demand-maintenance-briefing).
- Rationale: [ADR-0009](../../adr/0009-produce-a-bounded-maintenance-briefing.md).
- Context: [composition](../../design/composable-agents.md), [validation](../../design/validation.md).
- Contracts: [briefing](../../specs/maintenance-briefing.md),
  [readiness workflow](../../specs/readiness-workflow.md), [handoff](../../specs/location-handoff.md).
