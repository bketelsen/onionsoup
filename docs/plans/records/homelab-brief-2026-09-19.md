# Evaluation record: k3s and homelab brief — 2026-09-19

Historical evidence appendix to [the evaluation plan](../evaluations.md), phase 22.
This records deterministic software tests and an assistant-inspected live snapshot;
there was no model evaluation or independent human quality review.

## Method and boundaries

Source base: `0ecca8f`, plus the Kubernetes/brief implementation delivered with this
report. Runtime: Node 24.19.0; no provider/model or prompt. The source uses command
version `k3s-status-v1`, three reads, 20 seconds and 256 KiB per SSH process, a
65-second admission deadline, and at most 5,000 rows per section.

An initial non-sudo probe found k3s/kubectl installed but the system kubeconfig
unreadable; the explicitly pinned direct query returned exit 1. No kubeconfig was
printed or copied. After the owner authorized passwordless sudo for fixed reads,
one packaged live cluster attempt completed with all three projections. No retry,
Argo mutation, Secrets read, service change or remote installation occurred.

Live collection used existing SSH trust and the fixed loopback k3s endpoint. Raw
cluster objects were not transferred: status-only projection runs remotely. Host
addresses, local credentials and observation artifacts remain private/ignored.

## Results and evidence

The cluster observation `e4ea9afa-f6c1-461a-8034-6bcc0eb3b797` completed at
2026-09-20T01:17:24.306Z (evening 2026-09-19 America/New_York):

- Nodes: 1; Ready 1, not Ready 0, unknown 0.
- Pods: 32; Running 13, Succeeded 16, Failed 3; Ready 13, not Ready 19.
- Argo CD Applications: 3; Healthy 3, Synced 3.

These counts intentionally coexist. A succeeded pod need not remain Ready, a failed
pod is not automatically a current incident, and healthy Argo applications do not
prove all cluster pods healthy.

Refreshed independent observations retained earlier source behavior:

| Source run | Collection | Observed counts |
| --- | --- | --- |
| `3406ff76-e1fc-4f79-9f6c-3ce1b046eaa5` | TrueNAS completed | READY; 2 pools, no flags/unknown; 11 disks; 5 INFO alerts, 1 dismissed |
| `87a265d2-7a7d-4daa-966f-9402795c9537` | First compute host completed | Docker 1 running; SSH-user Podman 0; Incus 3 running |
| `5a30de74-0058-485e-996b-b2f12e2688b3` | Second compute host partial | Docker/Podman CLI unavailable; Incus 0 |

Saved brief `60b3828a-a39d-4d7b-b6ae-7b2dcf1f428e` embeds those four sources with
canonical hashes, scopes, times and generation-time freshness. The CLI wrote both
JSON and Markdown. All four sources were within the configured 900-second freshness
window at generation; missing coverage remains missing even for fresh attempts.

Software tests cover finite command authority and explicit sudo, header/row bounds,
independent statuses, unknown values, count partitions, persist-before-query,
cancellation, partial failures, privacy, duplicate source rejection, stale/future
snapshots, provenance replay and compiled offline CLI composition. Existing real
child-process tests cover shared SSH output/deadline/cancellation behavior. The
portable OSS release test also excludes both new homelab packages.

`npm run verify` passed with the pinned Node/Go integration fixtures and fresh
portable-release install enabled: 231 tests passed, zero failed, zero skipped.
Package boundaries, docs, generated capability manifests and typechecking passed.

## Limitations and next step

One live cluster snapshot establishes connectivity and projection compatibility,
not long-term reliability or incident accuracy. Queries are not atomic. The fixed
system kubeconfig can have cluster-admin authority; the client command boundary is
not RBAC. Other k3s paths, cluster contexts and restricted identities are unqualified.
Argo health/sync are controller-reported and may lag; applications can target remote
clusters. Missing CRD versus RBAC versus API failure is deliberately undiagnosed.

The brief is on demand from selected saved records. It neither schedules collection
nor exposes a homelab MCP service. A useful next experiment is a separately bounded
follow-up for failed pods, using approved diagnostic evidence to distinguish old
job failures from current workload problems. No such diagnosis or repair occurred
in this trial. Synology and server-side read-only identities remain later work.

## References

- Plan phase: [evaluation phase 22](../evaluations.md#phase-22--k3s-and-homelab-brief-qualification).
- Context: [package design](../../design/packages-and-recipes.md).
- Contract: [homelab brief](../../specs/homelab-brief.md).
- Decision: [ADR-0025](../../adr/0025-compose-k3s-and-gitops-observations.md).
