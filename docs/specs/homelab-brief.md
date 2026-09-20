# Spec: k3s observations and saved homelab briefs

`@onionsoup/kubernetes-source` collects bounded status counts over SSH.
`@onionsoup/homelab-brief` composes saved Kubernetes, [container](container-inventory.md)
and [TrueNAS](truenas-evidence.md) observations without network access or model calls.
The CLI is the operator-controlled host; agents receive neither shell nor credentials.

## Interface

```sh
npm run homelab -- kubernetes .local/homelab/kubernetes.json
npm run homelab -- brief .local/homelab/brief.json --output runs/NEW_BRIEF
```

Kubernetes target (strict version 1):

```json
{"schemaVersion":1,"assetId":"primary-cluster","host":"cluster.example.invalid","user":"operator","port":22,"access":"direct"}
```

`assetId` is a lowercase alphanumeric/hyphen identifier, maximum 64 characters.
Host/user syntax excludes shell metacharacters and option injection. Port defaults
to 22. `access` defaults to `direct`; operator-selected `sudo` adds only
`/usr/bin/sudo -n` before the fixed `/usr/bin/k3s kubectl` command. No fallback,
interactive prompt or privilege change is attempted automatically.

Every query pins `/etc/rancher/k3s/k3s.yaml`, context `default`, API endpoint
`https://127.0.0.1:6443`, a 10-second API request timeout and `/dev/null` discovery
cache. TLS verification remains enabled. Kubeconfig never leaves the remote host.
The system kubeconfig is trusted operator configuration; it may hold admin authority.
Sudo is not an RBAC restriction. No remote credentials, permissions or services are
created or altered. Nonstandard k3s paths/contexts/ports are unsupported in v1.

| Section | Fixed read | Persisted evidence |
| --- | --- | --- |
| `nodes` | `get nodes` | total; Ready true/false/unknown counts |
| `pods` | `get pods --all-namespaces` | total; Pending/Running/Succeeded/Failed/Unknown counts; Ready true/false/unknown counts |
| `applications` | `get applications.argoproj.io --all-namespaces` | total; Healthy/Progressing/Degraded/Suspended/Missing/Unknown counts; Synced/OutOfSync/Unknown counts |

Remote JSONPath projects only status tokens, prefixed with a version marker.
Successful stdout excludes names, labels, specs, container environments, repository
URLs and condition messages. Remote diagnostics are discarded without logging. Empty output without the marker is invalid, not an empty list. Unknown or
missing status tokens increment Unknown; malformed rows fail the section. Each
count group MUST partition its total. Kubernetes lists page through 200-item chunks;
local bounds cover the whole command and accepted response, not server-side work.
A missing CRD, RBAC denial or API error is `query_failed`, never zero applications.
This first adapter deliberately does not diagnose those errors from private stderr.

The callable `collectKubernetes(target, {directory, signal?})` persists
`observation.json` in a new exclusive directory. It admits each query before SSH,
then persists result/failure and the terminal run. No retries. `KubernetesRun` records
schema version, UUID, asset ID, target hash, access mode, `k3s-status-v1` command
version, timestamps, command hashes, section scopes, evidence and coverage status.
`completed` means all three reads succeeded; `partial` means some succeeded;
`failed` means none succeeded. It is a collection status, not a health judgment.

## Rules

- Reuse the runtime SSH primitive: fixed `/usr/bin/ssh`, existing trusted host keys,
  strict checking, no SSH config overrides, forwarding, tunnels or interactive auth.
  Container commands retain their existing no-sudo policy.
- Each SSH process has a 20-second deadline and 256 KiB combined stdout/stderr limit;
  one run has a 65-second admission deadline and at most three sequential queries.
  Each response has at most 5,000 rows. Stderr and failed stdout are discarded.
- Cancellation/timeout kills the local SSH child and skips later queries. It cannot
  guarantee remote process completion. API request timeouts additionally bound reads.
- Only fixed get commands are allowed. No Secrets, logs, exec, sync, refresh, patch,
  apply, delete, arbitrary kubeconfig/context, model-selected command or shell tool.
- Source artifacts retain no host/user, object names, raw output or diagnostic text.
  Local config files and raw run directories remain ignored by Git.
- Pod phases/readiness and Argo health/sync MUST remain separate. Running does not
  prove application health; Succeeded pods need not remain Ready. Argo status can lag.
  Multiple reads are not atomic, and the cluster can include nodes other than the
  queried host. An Argo Application may describe a different destination cluster.

## Saved brief composition

Brief host config (strict version 1):

```json
{"schemaVersion":1,"observations":["../../runs/NAS/observation.json","../../runs/CONTAINERS/observation.json","../../runs/K3S/observation.json"],"maxAgeSeconds":900}
```

Paths resolve relative to the config file. There are 1–32 saved observations, each
at most 1 MiB; no collection occurs. Duplicate run IDs or `(kind, assetId)` pairs
are rejected instead of silently double-counted. The pure function
`composeHomelabBrief(observations, {now?, maxAgeSeconds?})` validates source schemas;
`renderHomelabBrief(brief)` returns Markdown and verifies derived provenance/freshness.

The JSON contains version 1, `kind: homelab-brief`, UUID, generation time, freshness
threshold (1–86,400 seconds, default 900), and sources. Each source embeds the parsed
observation plus its SHA-256 of canonical `JSON.stringify(parsedObservation)` and
freshness at generation. This hash is provenance/integrity metadata, not a signed
attestation or authentication of an imported file. It is not the original file hash.

Age starts at collection start. Running, unfinished, future or reversed-time
observations have unknown freshness; old completed attempts are stale. A fresh
failed attempt still has missing coverage. Rendering preserves coverage failures,
count denominators, source scope, observation times and run IDs. No overall health
score, cross-source instance sum, incident diagnosis or remediation is generated.
A brief is a frozen snapshot; replay does not update its generation-time freshness.

The CLI writes private `brief.json` then `brief.md` to a new directory. Existing
output is never overwritten. An interrupted second write can leave just the JSON;
the exported renderer can reconstruct Markdown from it. This is an on-demand saved
brief, not a scheduled collector, homelab MCP host or delivery service.

## References

- Rationale: [ADR-0025](../adr/0025-compose-k3s-and-gitops-observations.md).
- Context: [package/recipe design](../design/packages-and-recipes.md).
- Delivery: [roadmap phase 24](../plans/roadmap.md#phase-24--k3s-gitops-and-a-homelab-brief).
- Qualification: [evaluation phase 22](../plans/evaluations.md#phase-22--k3s-and-homelab-brief-qualification).
- Upstream: [K3s cluster access](https://docs.k3s.io/cluster-access),
  [Kubernetes JSONPath](https://kubernetes.io/docs/reference/kubectl/jsonpath/),
  [Argo health](https://argo-cd.readthedocs.io/en/stable/operator-manual/health/),
  [Argo metrics and sync status](https://argo-cd.readthedocs.io/en/stable/operator-manual/metrics/).
