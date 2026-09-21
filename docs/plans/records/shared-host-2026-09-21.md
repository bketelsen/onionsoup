# Evaluation record: Shared capability host — 2026-09-21

Historical evidence appendix to [evaluation phase 26](../evaluations.md#phase-26--shared-host-qualification).
Software checks and assistant-reviewed live trials are reported separately.
Independent user acceptance and production reliability remain unmeasured.

## Method and boundaries

Implementation builds on `b25e269`; the host/client changes are committed alongside
this report. Runtime protocol is `job-host-v1`, registered capability versions are
`v1`, chat/profile versions remain `chat-v1` / `homelab-chat-v2`, and workload triage
uses `workload-triage-v4`. Repository themes/health/actions retain their v1 prompts.
All live model calls used the configured Copilot subscription and `gpt-5.6-terra`.

One compiled loopback host served two invokers: chat could invoke homelab capabilities;
the scheduled worker could invoke only `repository.brief` for `bketelsen/onionsoup`.
Each had 64 lifetime admissions in the private ledger. Its configuration binding was
`b6fb5803de9e9944730157c6fd089d49c58668e0e23a861ebcf1a8a7196464a8`.
The host ran one capability at a time; the scheduled request queued behind the
workload investigation. Existing fixed reads and normalized evidence boundaries
remained in force. No infrastructure mutation or GitHub publication was requested.

Scheduled delivery used a separate local capture relay with no forwarding. The
trial config kept 08:00 America/New_York but allowed a 24-hour catch-up window for
the daytime test. Existing timers and delivery configurations were not replaced.

## Results and evidence

### Scripted qualification

Full `npm run verify` passed with **272 tests, zero failures and zero skipped tests**,
including configured fixture/Go/TypeScript execution and a fresh portable release
installation (`ONIONSOUP_RELEASE_INSTALL=1`). The portable brief release contains
the generic client dependency but excludes the homelab implementations and host app.

New tests exercise authenticated HTTP, browser-origin rejection, strict input
validation, capability grants, owner-only reads/cancellation, concurrent duplicate
submission, conflicting idempotency keys, persistent quotas, changed bindings,
interruption without replay, cancellation, invalid outputs, result tampering and
persistence failure stopping later admission. A two-consumer fixture runs actual
chat control flow and the existing scheduled-delivery ledger through the same HTTP
host, preserving partial source coverage and sending once across repeated ticks.
Scripted models demonstrate integration properties, not judgment accuracy.

### Live chat

Session `0f959604-4b84-4a94-93ae-1fe9bfb8d6c8` is saved privately at
`runs/chat/ad2abf2e-3548-4d2f-9d7e-efebeb25167a/session.json`.

| Turn | Outcome | Steps | Parent input/output tokens |
| --- | --- | ---: | ---: |
| `f54b2f8c-2b06-44db-9139-bd3860d6b602` | Fresh investigation, completed | 3 | 6,398 / 390 |
| `a789b38b-4e42-4eb9-bca2-5aa64b14d014` | Explanation after host restart, completed; no new admission | 3 | 11,181 / 452 |

Shared job `df331d31-ec7f-4ea5-8260-b02bf544697a` ran from 14:38:39 to 14:38:57 UTC,
correlated to that chat session. It produced triage
`843d551b-fc1b-4e2b-9aa1-f36ac8fef39a` from source
`1bf21a91-5e15-4ff0-84a1-b4f36b60bf37`; child usage was 8,019 / 1,796 tokens.
The validated result contained three attention, five historical and two insufficient
findings among ten selected of sixteen eligible pods, with six omitted.

Assistant inspection found the answer consistent with those counts and coverage.
After the service stopped and restarted, the second turn reopened the exact finding
`r-351ffad42fbff09cda6fc3f950b3a2a973f2839d541919a08ea013a9ce8b9e1d` and its cited
facts. It described the failed Pod and still-running Workflow without claiming a
root cause or a new collection. The evidence was 169 seconds old at submission.
Reused child usage was not charged as another invocation.

### Live scheduled brief

Shared job `71923df3-483e-44c3-9e4b-ddb615cf19ce` was queued at 14:38:49 UTC and ran
from 14:38:57 to 14:39:20. Its correlation ID is delivery workflow
`6da6adb3-1037-4cb9-882f-918d8afbbcc7`, occurrence `2026-09-21T08:00`.
It produced repository brief `5f5b3547-de22-4c8d-8794-a4a7cb9164b1`:

- Three of four allowed agent calls; issue themes skipped because no open issues.
- Two open PRs, each in one theme, and explicit current-versus-window counts.
- No observed default-branch Actions runs; success rate remained unknown.
- One verified first-time PR author within the searched population.
- Ten of twenty allowed read-only API requests; three proposed actions.
- Child model usage totaled 2,273 input / 981 output tokens. Billed cost and remaining
  subscription quota were not measured; zero provider cost estimates are not a claim
  of free usage.

The private Markdown artifact is
`runs/shared-job-host/71923df3-483e-44c3-9e4b-ddb615cf19ce/analysis/repository-brief.md`.
The worker saved its host receipt and frozen mail in the separate delivery ledger.
The relay accepted one message without forwarding. A repeated tick returned the
same accepted occurrence and single attempt. A direct duplicate API submission
returned the same job with `reused: true`; each invoker still had 63 admissions left.
The host retained two jobs after restart and the relay retained exactly one message.

Counts, citations and CI limitations were consistent with saved evidence. One action
suggested welcoming the repository owner as a first-time PR author. That is grounded
in the narrow contributor metric but awkward as maintainer advice; role/context
awareness remains a task-quality limitation, not a hosting success criterion.

## Limitations and next step

This qualifies a local supervised pilot across two consumers and domains. No live
provider fault, machine crash, sustained load, remote TLS, multiple workers or
production SMTP delivery was exercised. Crash/interruption behavior has scripted
coverage; the live restart was orderly. The host uses a private single-writer file
ledger with bounded lifetime admissions, not a distributed durable queue.

Interrupted jobs remain inspectable but are never replayed. Unknown scheduled
generation outcomes need explicit operator recovery; later ticks do not silently
regenerate or retrieve a result. Cancellation is cooperative. Version/configuration
bindings are not signed release attestations. New tools and management authority
cannot be registered over the API.

Next: use the shared host for ordinary read-only chat and scheduled briefs, collect
operator friction, and add inspection/recovery conveniences where actual cases
justify them before expanding deployment or mutation authority.

## References

- Plan: [evaluation phase 26](../evaluations.md#phase-26--shared-host-qualification),
  [roadmap phase 28](../roadmap.md#phase-28--shared-capability-job-host).
- Context: [composition](../../design/packages-and-recipes.md),
  [validation](../../design/validation.md).
- Contracts: [shared host](../../specs/job-host.md), [chat](../../specs/chat.md),
  [scheduled delivery](../../specs/scheduled-delivery.md).
- Rationale: [ADR-0029](../../adr/0029-host-reviewed-capabilities-through-a-shared-job-api.md).
