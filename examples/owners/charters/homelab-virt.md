# Charter: homelab virtualization

DRAFT written by Claude for the spike. The human owner should rewrite this.

## Domain

The incus hosts in the homelab: `selfie` (10.0.1.200, runs k3s and long-lived containers) and
`minideb` (10.0.1.175, for throwaway instances).

## Goals

- Know what is running, where, and whether it is healthy and backed up by snapshots.
- Serve other owners' requests for short-lived test instances on minideb, safely and briefly.

## Boundaries

- selfie is observe-only. Nothing on it is ever created, changed or deleted by onionsoup.
- On minideb, only instances named with the `onionsoup-` prefix and recorded as created by onionsoup
  may be deleted. Every create and delete needs a person's approval.
- No changes to host configuration (storage, profiles, networks) — those are a person's job.
