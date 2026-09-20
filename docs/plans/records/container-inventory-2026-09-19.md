# Evaluation record: SSH container inventory starters — 2026-09-19

Historical evidence appendix to [the evaluation plan](../evaluations.md), phase 21.
Assistant-run transport/acquisition qualification, with no model calls or quality claims.

## Method and boundaries

The owner authorized read-only queries on two compute hosts. Existing SSH public-key
access and trusted host keys worked with the current account. Checked executable
availability and CLI help; observed Docker 29.8.1, Podman 5.4.2 and Incus 7.4 where
installed. Queried only state columns through fixed local-engine endpoints and
repeated acquisition through the Onionsoup homelab command. No sudo, installs,
remote API exposure, configuration changes, forwarding or workload mutations occurred.

Live host addresses, usernames and observations remain in ignored local configuration
and run directories. No infrastructure names or credentials are used as public fixtures.
The new package is version 0.1.0; commands are versioned `ssh-container-states-v1`.

## Results and evidence

Both hosts authenticated successfully. One observation completed all three engines;
the other was partial because two fixed CLI paths were unavailable. Successful empty
inventories remained zero-count observations, while unavailable engines had no counts.
The existing account's Podman storage and local Incus daemon views are the scope;
neither establishes an exhaustive inventory of every user, socket or physical host.

Seven focused tests cover strict target/command boundaries, state normalization and
unknown values, persisted admission, unavailable versus empty results, failure/no-retry
semantics, cancellation and storage rejection. Real local subprocess tests additionally
exercise termination on timeout/cancellation, combined stdout/stderr bounds and raw
error suppression without depending on a live SSH service.

Final `npm run verify` passed: **223 tests, 223 passed, zero skipped**, including
Go/Node/fixture execution and fresh portable-release installation. Documentation
checks covered 96 documents, 13 skills and five symlinks; dependency checks covered
13 workspaces. The compiled homelab CLI also passed its help smoke check.

## Limitations and next step

This establishes bounded inventory collection, not application health or drift from
an intended configuration. Docker health checks, images, logs and configuration were
not read. Other users' Podman storage and nonstandard Docker sockets were not queried.
Incus can expose a cluster view and must not be double-counted across endpoints.
The client issues read-only commands using an existing, potentially broader account;
server-side restricted credentials remain a separate deployment step.

Next compose these observations with TrueNAS evidence through a small versioned
homelab brief contract. Keep deterministic counts and coverage in host code; use any
future model only for a separately bounded interpretation job.

## References

- Plan phase: [evaluation phase 21](../evaluations.md#phase-21--ssh-container-inventory-qualification),
  [roadmap phase 23](../roadmap.md#phase-23--ssh-container-inventory).
- Rationale: [ADR-0024](../../adr/0024-collect-container-inventory-over-bounded-ssh.md).
- Context: [package design](../../design/packages-and-recipes.md).
- Contract: [container inventory](../../specs/container-inventory.md).
