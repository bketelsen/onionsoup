# 0011 — Separate scheduled analysis from mail delivery

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

The repository brief is useful as a scheduled maintainer report. SMTP introduces
an external effect with an ambiguous crash window; repeating analysis on a mail
retry wastes subscription usage and can change what the recipient receives.

## Decision

Use a one-shot host adapter driven by an operator's scheduler. A local occurrence
ledger binds a job, wall-clock occurrence, configuration and saved brief. Freeze a
MIME message before sending, persist each send intent, and retain its observed
outcome. Reuse that exact message for explicit retries. Stop ambiguous sends for
operator reconciliation. Use an exclusive local filesystem lock for concurrent
workers and require a stopped-worker check before manual stale-lock removal.

Recipients and SMTP settings come only from operator configuration. Agents remain
read-only and transport-independent. Use Nodemailer for MIME and SMTP; require TLS
except for an explicitly selected loopback relay. Export correlated, content-free
workflow events from validated delivery records.

## Consequences

A scheduled occurrence admits at most one analysis attempt and three SMTP attempts.
Recovery can adopt a completed saved analysis without invoking models. SMTP
acceptance is not inbox delivery; Message-ID is correlation, not idempotency.
Unknown results require an operator, and abandoned analysis is not automatically
replayed. This is a single-host adapter, not a distributed queue or an exactly-once
system. Local checkpoints do not promise power-loss durability.

## Alternatives considered

- **Send inside an agent:** expands authority and ties retries to model execution.
- **Retry every network error:** can duplicate mail accepted before a lost response.
- **Install a universal workflow engine:** premature for one scheduled recipe.

## References

- Builds on: [ADR-0010](0010-compose-a-repository-brief-from-bounded-evidence.md).
- Shapes: [packages and recipes](../design/packages-and-recipes.md),
  [scheduled delivery](../specs/scheduled-delivery.md),
  [backlog P8](../plans/backlog.md#phase-8--scheduled-delivery).
