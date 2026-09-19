# 0012 — Operate saved workflows through a local console

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

The static issue inbox and scheduled brief adapter produce useful artifacts, but
operators must inspect files to find reports, check delivery and start a follow-up.
A browser control introduces a new authority boundary around local processes.

## Decision

Add a loopback-only operator console to the inbox command. Read configured report
and delivery directories, render validated artifacts, and expose narrowly typed
POST actions: run a brief now, pause/resume future ticks, retry eligible delivery,
and investigate one issue selected from a saved brief. Preserve the old static
issue inbox through a scoped route.

Require exact Host/Origin checks, a per-process CSRF token and artifact/configuration
preconditions. Persist action identity before work, serialize active console work,
and never replay an interrupted action automatically. Reject client-selected paths,
models, recipients and shell commands. All analysis uses the existing recipes.
A fresh issue read and configured pinned checkout precede investigation; the
packet retains its original readiness/location boundaries and links to its parent
brief through the operator action record.

## Consequences

The operator can inspect history and initiate bounded work without JSON editing.
Local processes and the operator's private configuration remain trusted. This is
not a remote multiuser service. Pause prevents subsequent scheduled admissions;
it neither cancels an active job nor deletes history. Delivery ambiguity still
requires evidence-based CLI reconciliation. A proposed route toward PRs remains
a separate design exploration, without code execution or publication authority.

## Alternatives considered

- **Add write actions to static HTML:** requires an authority boundary anyway.
- **Let action suggestions dispatch agents:** model proposals are not authorization.
- **Build a general workflow designer:** current recipes already expose the needed
  contracts; first establish that a small operator surface is useful.

## References

- Builds on: [ADR-0011](0011-separate-scheduled-analysis-from-mail-delivery.md),
  [ADR-0004](0004-compose-bounded-maintenance-agents.md).
- Shapes: [operator console design](../design/operator-console.md),
  [operator console contract](../specs/operator-console.md),
  [backlog P9](../plans/backlog.md#phase-9--operator-console).
