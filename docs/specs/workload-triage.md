# Spec: Workload triage and homelab MCP

A deterministic source collects bounded Kubernetes workload facts. One focused
AgentLayer agent decides whether each selected pod failure appears current,
historical, or insufficiently evidenced. The consumer is the saved homelab brief.

## Interface

Source evidence contains source run/target hashes, asset ID, collection
start/end, section coverage and at most ten selected candidate pods with an explicit
eligible/omitted count. Facts use stable hashed resource IDs and supplied evidence
IDs. Resource names stay in a private local lookup, outside model input.

The result partitions the selected pod IDs exactly once into `attention_now`,
`historical`, or `insufficient_evidence`. Each finding supplies evidence IDs,
a short reason and one next-investigation choice. The host validates references,
coverage/freshness, current-state signals and recovery prerequisites. It does not
validate every semantic claim in prose.

## Rules

- Fixed reads only: pods, Jobs, ReplicaSets, Deployments and Argo Workflows in all namespaces of
  the pinned k3s loopback endpoint. Explicit configured sudo is allowed for these
  reads under the owner's authorization. No logs, events, Secrets, exec or mutation.
- Project creation/deletion time, controller UID/kind, phase, readiness, restarts,
  normalized current/last container termination reasons/exit codes/times, controller
  generations, replica counts and Job conditions. No specs except desired replica
  count; Workflow phase/completion time only; no images, commands, environments, annotations, labels or error prose.
- At most five sequential 20-second/256-KiB SSH reads, 5,000 rows per section,
  105-second source deadline; no automatic task retries. Persist before each read.
- Age alone never proves historical. A completed owning Job or an observed/current
  ready owner/replacement chain is required. Unsupported/missing owners remain
  explicit. Failed/incomplete reads cannot become empty evidence.
- One triage invocation, at most three logical model steps, 90-second cooperative
  deadline, bounded context and results. Provider retries are not separate task
  retries; actual token usage is recorded when available, cost remains unknown.
- Saved evidence older than 15 minutes, future or unfinished evidence cannot support
  confident classifications. Model/provider selection belongs to the host (Terra
  with Copilot/Codex); the model has only `submit_result`.
- Saved artifacts include source/input hashes, prompt/model version, step events,
  usage, result or explicit failure. No automatic recovery/replay. Scripted tests
  establish runtime properties; live judgments require a separate quality review.

## References

- Rationale: [ADR-0026](../adr/0026-triage-workload-findings-through-bounded-evidence.md).
- Context: [package design](../design/packages-and-recipes.md).
- Consumer: [homelab brief](homelab-brief.md).
- Work: [roadmap phase 25](../plans/roadmap.md#phase-25--workload-triage-and-homelab-mcp).
- Upstream: [pod lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/),
  [Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/),
  [owner references](https://kubernetes.io/docs/concepts/overview/working-with-objects/owners-dependents/).

## Callable functions and artifacts

- `@onionsoup/kubernetes-source/workloads`: `collectWorkloads(target, {directory,
  signal?, transport?})`. Target is the existing strict `KubernetesTarget`. The
  transport injection is a trusted host/test seam, never an MCP argument.
- `@onionsoup/workload-triage`: `triageWorkloads(observation, {directory, provider,
  modelId, modelFactory, signal?})`. It validates bounded input and persists admission
  before initializing the model. `investigateWorkloads(target, options)` composes
  collection and triage under a 200-second cooperative deadline. One investigation
  admits at most one agent invocation, with the agent's three logical steps.
- `workloadCapabilityManifest()` derives discoverable schemas/limits without auth.
  It is also published in the root capability catalog with generated drift checks.
- `findingCounts(result)` computes exact classification/selected counts from validated
  results for MCP, briefs and conversational consumers. The model does not count.
- `workloadEvents(run)` derives the common workflow event envelope from validated
  records, including parent source run, usage and safe result-rejection codes.
  It emits no facts, prose, resource names or transport diagnostics. It is a derived
  snapshot, not a live event stream. Root event export dispatch supports it.

A collection directory contains `observation.json` plus `resources.private.json`,
which maps the selected/related hashed IDs to resource names and namespaces. Only
the former is agent input. Both files are private, ignored run artifacts. Observations
persist each query status before and after contact. Raw unselected projections
are discarded. A triage directory contains `triage.json`: input snapshot/hash,
provider/model, prompt version, events, token totals, result/failure and timestamps.
Current prompt/context is `workload-triage-v4`, including host-calculated source
freshness and missing-section metadata. Original v1/v2 prompt runs remain readable.
`modelInvoked` means model admission/initialization was attempted; it is not a count
of provider HTTP requests. `steps` counts observed logical AgentLayer steps.

The parent investigation records its intent in `investigation.json`, then writes
children under `source/` and `triage/`. Crashed running records stay unfinished.
Semantic result rejections are checkpointed before a correction; unparsed tool
schema failures are visible as additional steps but have no semantic rejection
code. Full provider transcripts are not retained. A persistence error stops further
work; no background resume or automatic retry is offered.

Candidate policy: failed pods first, then other Pending/Unknown pods or Running
pods that are unready/unknown-ready; ready pods with restart history are last. Each tier sorts by
hashed ID. Select ten, record eligible and omitted counts, and retain up to three
facts per candidate along its owner chain. This is explicit bounded coverage,
not a claim of importance ranking. Succeeded pods are not selected on their own.
Pod age does not measure failure duration. Missing numeric fields remain null.
Known container reason enums are retained; unrecognized reasons become Other.

Recovery gates require fresh complete source coverage. A healthy replica controller
has observed the current generation, has positive desired replicas, and ready,
available and updated/current counts at least desired. A failed old ReplicaSet
pod may cite its current Deployment through the UID chain. A running unready pod
cannot be cleared by sibling readiness. Unsupported StatefulSet, DaemonSet or custom
owners other than the explicitly supported Argo Workflow cannot establish historical
recovery in this version. Insufficient evidence
is always allowed with an explicit next investigation. These gates are conservative
necessary conditions; semantic support still needs evaluation.

## CLI and brief integration

```sh
export ONIONSOUP_AUTH_PATH=/absolute/private/subscription-auth.json
npm run homelab -- investigate .local/homelab/kubernetes.json --provider copilot
# Add the resulting triage/triage.json path to the saved brief config:
npm run homelab -- brief .local/homelab/brief.json
node --conditions=onionsoup-source --import tsx scripts/eval-workload-triage.ts copilot
```

Live CLI/MCP hosts pin `gpt-5.6-terra`; there is no fallback provider/model. The
fixture evaluation writes expected labels separately from model input, records all
twelve cases, and does not establish independent human acceptance. Private names do
not enter prompts, MCP responses or public reports. Normalized status evidence and
model explanations are still potentially sensitive homelab information.

The saved brief's source union additionally accepts version 1 `workload-triage`
records. Existing brief/source versions remain readable. Attention entries show
classification, reason, evidence IDs and a fixed next-investigation choice. Failed
or running agents remain unavailable; omitted candidates and partial source reads
stay explicit. Freshness starts at source collection, not model completion. This
is a snapshot assessment, never an authorization to operate services.

## Homelab MCP host

```json
{
  "schemaVersion": 1,
  "provider": "copilot",
  "runsDirectory": "../../runs/homelab-mcp",
  "observations": ["../../runs/SOURCE/observation.json"],
  "targets": [{"schemaVersion":1,"assetId":"primary-cluster","host":"cluster.example.invalid","user":"operator","access":"direct"}],
  "maxJobs": 4
}
```

Launch `npm run mcp:homelab` (or compiled `apps/homelab-mcp/dist/main.js`) with
`ONIONSOUP_HOMELAB_CONFIG` pointing to this private host file and subscription auth
configured separately. Paths resolve relative to the config; clients never select
them. Up to 16 saved source paths, 10 unique targets and 1–10 jobs (default 4) are
allowed. Each process permits one active job. A synchronous reservation precedes
storage and all effects. Admission failures still consume the allowance; a process
restart resets it. This is not a persistent spending quota.

| Tool | Strict arguments | Behavior |
| --- | --- | --- |
| `discover_homelab` | `{}` | IDs, capability/schema, budgets/effects; no credentials, host addresses or paths |
| `investigate_workload_findings` | `{targetId}` | Fixed collection and one bounded triage; returns job ID |
| `create_homelab_brief` | `{investigationJobIds?: UUID[]}` | Configured saved sources plus up to 10 settled investigation results; no new collection/model work |
| `inspect_homelab_job` | `{jobId}` | Lifecycle and sanitized assessment/events or rendered Markdown |
| `cancel_homelab_job` | `{jobId}` | Cooperative abort; keeps evidence and consumed allowance |

Repeated submits are new attempts. Duplicate investigation IDs are rejected; adding
two triages of the same asset to a brief fails rather than silently choosing one.
Keep baseline source files in the host config and attach the chosen investigation
job ID when creating the brief. Job receipts bind a hash of normalized host config.
Inspection after restart requires the same config and validates target, provider,
model and input provenance. Unfinished jobs are not replayed. Symlink substitutions
and client-supplied path/command/provider fields are rejected.

The stdio application owns an exclusive `.host-lock` directory. A crash can leave
that lock; the operator verifies the old process has stopped before removing it.
Cancellation is cooperative and depends on provider/SSH abort support. Local SSH
termination does not prove remote process exit. External scheduling, network MCP,
service deployment and homelab repairs remain separate work.

## Workflow owner evidence v2

[ADR-0027](../adr/0027-observe-workflow-owners-and-prove-model-delegation.md)
extends collection to five fixed projections with `workflows.argoproj.io`. New
observations use schemaVersion 2 and commandVersion `k3s-workloads-v2`; v1 remains
readable with exactly its original four sections and facts. V2 projections include
controller API version to recognize only `argoproj.io/v1alpha1` Workflow references.
All other custom kinds remain Other. Only phase and finishedAt are added to the
common Workflow identity/creation/deletion facts. No Workflow spec, node graph,
parameters, artifacts, templates or messages are collected.

The source deadline is 105 seconds; investigation is 200 seconds. Row, byte,
candidate and per-read bounds are unchanged. Missing CRDs or denied access mean
partial coverage and insufficient evidence. StatefulSet, DaemonSet and CronWorkflow
status remain unsupported. There is no inferred relationship to Argo CD.

Prompts v3/v4 permit historical classification for a matching nondeleting Workflow
with Succeeded phase and a completion time between creation and assessment. A
failed pod owned by a Workflow in Running, Failed or Error phase can warrant
attention: review that unresolved execution, without claiming an active outage.
Terminal phases require a valid completion time; Pending, Unknown, missing owners,
invalid timing and incomplete/stale evidence cannot establish this conclusion.
Citations must include the Workflow when it supports a confident classification.
No successor/schedule recovery is inferred. Old v1/v2 prompts cannot consume v2
observations; their saved judgments keep the original validation rules. Prompt v4 adds explicit
host-computed per-pod classification prerequisites and required historical witness
IDs to context. Correction feedback identifies the rejected pod and a fixed safe
correction hint; persisted/common rejection events retain their original codes.
These gates constrain confidence; they do not establish the truth of model prose.

The [model delegation proof](homelab-delegation.md) consumes these jobs; implementation
and qualification belong to [phase 26](../plans/roadmap.md#phase-26--workflow-owners-and-model-delegation).
