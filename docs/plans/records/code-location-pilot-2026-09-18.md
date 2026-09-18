# Code-location pilot — 2026-09-18

The new agent can produce traceable investigation starting points from a readiness
handoff. Search relevance is uneven: useful for the two reports that name the
implementation, weaker for the report requiring discovery across packages. This
is a development pilot, not maintainer acceptance or an accuracy estimate.

## Fixed inputs and authority

- Three existing inbox snapshots: get-bb/bb issues **3773**, **3607**, **3899**.
  They were selected deliberately for different subsystems, not sampled randomly.
- Existing completed `bug_report / ready` assessments; no readiness reruns.
- Copilot subscription, explicitly `gpt-5.6-terra`; no other model/provider calls.
- Bare clone at `3a4288bd0f34f888a5eb43f1099f7b60fe86eea4`. The agent reads
  committed blobs; it cannot run code, tests, a shell, or GitHub mutations.
- Bounds: 12 model steps, 12 inspections, 36,000 returned source characters,
  180 seconds per run. The source commit differs from the reported releases.
- Input revision and parent run identity are retained. Eligibility uses the saved
  inbox observations; dispatch did not re-fetch issues or comments.

## Runtime results

| Issue | Prompt | Status | Steps | Inspections | Read-range errors | Seconds |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 3773 | v1 | located | 4 | 12 | 1 | 54.11 |
| 3607 | v1 | located | 5 | 12 | 3 | 74.30 |
| 3899 | v1 | located | 6 | 12 | 2 | 47.18 |
| 3773 | v2 | located | 5 | 12 | 0 | 20.18 |
| 3607 | v2 | located | 7 | 12 | 0 | 26.59 |
| 3899 | v2 | located | 8 | 12 | 0 | 23.71 |

All six runs completed the contract. All 23 output citations were independently
compared with the pinned Git blobs; their paths, line ranges, and quotations
matched. This establishes text grounding, not relevance or diagnostic correctness.
Each three-report pass was repeated unchanged and returned three
`skipped_completed` outcomes without additional model calls.

V1 consumed all 36 available inspections across the three reports, including six
oversized reads rejected by the 60-line limit. V2 moved that sizing responsibility
into the reader: an oversized request returns an explicitly truncated page with
actual bounds and a next-line pointer. The tool also reports remaining inspection
calls. The prompt prioritizes direct implementation and related tests. Public
input/output contracts remain version 1; prompts and runtime hashes distinguish
the behavior change.

V2 eliminated these read errors but still consumed all 36 inspections and used
more model steps. SDK-reported input/output tokens were **72,702 / 3,872** for v1
and **102,259 / 4,933** for v2. Cached-token counts are retained in each run.
Lower observed latency in the second pass does not establish a general speed or
cost improvement. The SDK's zero estimated cost is not a measured bill;
subscription quota consumed and billed cost remain unknown.

## Assessment of usefulness

This assessment comes from the coding assistant reading the reports, citations,
and surrounding pinned source. It is not independent human grading, and the v2
prompt was tuned using the v1 failures on these same examples.

**3773 — desktop artifact packaging:** v1 located the endpoint, command runner,
and peripheral tests, but missed the actual packaging call after an oversized
read exhausted its budget. V2 cites `buildArtifact` at lines 247–275 and
`defaultCommandRunner` at 67–76 in
`apps/server/src/services/install/bb-app-artifact.ts`. It also finds the direct
`bb-app-artifact.test.ts` setup at 178–204 plus the route test. These are useful
starting points for the npm spawn report. The direct-test quotation mostly shows
setup, not the later artifact assertions; it does not demonstrate a GUI-PATH
regression test. V2 is materially more useful for this report.

**3607 — Claude configuration directory:** both versions identify the concrete
credential/account reads and health/usage consumers in
`plugins/provider-claude-code/src/bridge/provider-maintenance.ts`. V2 adds the SDK
`resolveClaudeConfigDir` definition for comparison. These are relevant code
pointers. Neither version reads and cites the direct credential tests despite
finding test paths. V2 spent its remaining calls on more searches instead of a
test read. Its empty test list and uncertainty are honest, but the investigation
brief is incomplete on the test side. Independent inspection confirms relevant
tests exist in `provider-maintenance.credentials.test.ts`.

**3899 — missing ACP reasoning variants:** v1 found the shared model catalog's
`thought_level` mapping, although its picker-test fixture was peripheral. V2
stayed inside `plugins/provider-acp`, cited registration/declaration code, and
missed the shared catalog implementation. Its cited declaration test mostly
shows surrounding agent wiring; this is weak evidence for the reported symptom.
V2 is a relevance regression on this case, despite valid quotations and explicit
uncertainties. Independent source inspection finds the report's exact placeholder
description in `packages/provider-bridge-acp/src/bridge/model-catalog.ts`, alongside
fallback logic and a direct `model-catalog.test.ts` suite. No runtime diagnosis
was attempted.

The inbox displays the latest v2 results consistently; it does not silently pick
the best output from each pass. Historical v1 records remain available on disk.

## Artifacts and verification

Records: `runs/inbox/get-bb--bb/locations/`; UI:
`runs/inbox/get-bb--bb/index.html`. Each record contains the parent ID, full issue
hash, repository commit, prompt/runtime identity, tool activity, read excerpts,
AgentLayer state, usage, and result.

| Issue | v1 run ID | v2 run ID |
| --- | --- | --- |
| 3773 | `c0f2b0b1-0db4-4a51-a885-19724baab333` | `5ff02644-1976-4abc-b85c-749cf52daeb0` |
| 3607 | `edb6e7cf-85ad-4ee7-9e69-0594e539f272` | `da41bcd9-5c1f-49db-8af1-ec703f73b787` |
| 3899 | `66962900-2ec9-4957-a66d-1925b1930cc6` | `b8ed5aa9-2683-45a6-8ade-4df8c5f92eec` |

V1 runtime hash: `0dffbc5a2772f9912754a4d9d1d0a470decdade48135bc282870fe19e17bd40e`.
V2 runtime hash: `e82889888eeafcb5e257186e9646a00049183fb54d32c4379a921c8b23811fe9`.

`npm run verify`: 39 tests passed. `npm run demo`: passed. New checks cover stale,
closed, non-bug, and incomplete handoffs; pinned blob reads; unavailable paths;
read pagination and budgets; citation validation/correction; admission failure;
cancellation; bounded execution; explicit retries; cache reuse; and safe rendering.
Browser checks verified all three attachments, commit-specific links, expandable
source/provenance, mobile width, and no JavaScript errors. The existing readiness
runtime hash and its 17 records remain unchanged by location dispatch.

## Next bounded improvement

Keep this agent's responsibility fixed. Improve search decisions before adding a
third agent: prioritize distinctive literal messages, broaden a fruitless
directory search, and turn a promising direct-test match into a read before more
searches consume the budget. Measure stronger starting points and actually read
test assertions on saved cases, while retaining regressions. Broader confidence
will still need unseen reports, including ones without implementation hints and
ones with misleading paths or embedded instructions. Do not infer readiness for
diagnosis, fixes, or autonomous GitHub actions from this pilot.

## References

Historical evidence appendix to [the evaluation plan](../evaluations.md).
Results apply to the versions and inputs recorded above; relocation does not
establish current task accuracy or independent maintainer acceptance.

- Context: [validation](../../design/validation.md).
- Contracts: [readiness](../../specs/bug-readiness.md),
  [batch evaluation](../../specs/batch-evaluation.md),
  [inbox](../../specs/inbox.md),
  [code-location](../../specs/code-location.md),
  [packet](../../specs/investigation-packet.md).
