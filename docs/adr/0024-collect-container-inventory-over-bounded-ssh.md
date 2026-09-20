# 0024 — Collect container inventory over bounded SSH

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

The owner authorized Docker, Podman and Incus starters on two homelab hosts.
Existing SSH credentials and trusted host keys work. The hosts expose different
engines and user scopes; opening management APIs is unnecessary for first contact.

## Decision

Use an operator-configured SSH target and three fixed read-only inventory commands.
The model cannot choose shell text, command arguments, users, hosts or sockets.
Force Docker's standard local socket, Podman's local mode and Incus's local socket;
collect states only. Preserve unavailable engines and failed queries as missing
coverage, never zero counts. Use strict existing SSH host-key trust and no sudo,
agent forwarding, tunnels, configuration changes or remote installation.

Publish the evidence through a reusable package and the existing homelab CLI.
Each query has a persisted admission, timeout and combined output bound. No LLM is
needed for inventory. A later interpreter can consume normalized artifacts without
receiving an SSH shell or daemon credentials.

## Consequences

This uses existing access with a narrow command surface, but the SSH account itself
may hold broader privileges: client-side restrictions are not server-side RBAC.
Podman inventory is user-scoped, Docker is socket-scoped and Incus may be cluster-wide.
Service health, desired-state drift and repair are separate jobs. A restricted SSH
key with a forced command is a future deployment hardening option, not installed here.

## Alternatives considered

- **Expose daemon APIs:** expands network configuration before it adds value.
- **Generic shell tool for an agent:** provides unnecessary authority for inventory.
- **Install a remote agent first:** adds deployment work where existing CLIs suffice.

## References

- Builds on: [ADR-0022](0022-package-capabilities-with-thin-host-applications.md),
  [ADR-0023](0023-collect-read-only-truenas-evidence-through-existing-mcp.md).
- Shapes: [package design](../design/packages-and-recipes.md),
  [SSH inventory contract](../specs/container-inventory.md),
  [roadmap phase 23](../plans/roadmap.md#phase-23--ssh-container-inventory).
