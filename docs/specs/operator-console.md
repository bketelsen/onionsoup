# Spec: Local operator console, version 1

This contract governs the loopback inbox server, its operator actions and links
between aggregate briefs and investigations. It wraps existing recipes without
changing agent capabilities. Implementation (removed 2026-09-21; see the web design page).

## Interface

```sh
npm run inbox -- serve --config .local/console/config.json --port 8765
```

Copy the former example configuration (removed 2026-09-21) into `.local/console/`
and adjust its paths to existing operator-owned artifacts. Add `source` only
after selecting a matching local checkout and full commit.

Configuration is strict version 1 with `stateDirectory` and 1–10 unique `jobs`.
Optional top-level `fixtureRoots` contains at most ten local saved-trial roots.
Optional top-level `publicationConfig` names the host [draft publisher configuration](draft-publication.md). These paths resolve relative to the configuration file.
Each job has a lowercase/hyphen `id`, `deliveryConfig`, `deliveryState`, and up to
ten `briefRoots`. Optional fields: `inboxDirectory`, a systemd `timerUnit`, and
`source: { checkout, commit }` with a full 40-character Git commit. Paths resolve
relative to the configuration file. Delivery credentials remain in the existing
private environment/configuration boundary. Jobs cannot select a model from HTTP;
current execution remains Terra on their configured Copilot/Codex subscription.

| Route | Behavior |
| --- | --- |
| `GET /` | Jobs, counts/coverage, brief history, delivery history, schedules and controls |
| `GET /briefs/JOB/UUID` | Saved report plus issue selection and prior-investigation links |
| `GET /briefs/JOB/UUID/report`, `/markdown`, `/json`, `/events` | Validated derived report or saved evidence/trace |
| `GET /deliveries/JOB/OCCURRENCE/events` | Validated delivery trace |
| `GET /fixtures`, `/fixtures/UUID`, `/fixtures/UUID/json`, `/markdown`, `/events`, `/diff` | Read-only owned fixture history and artifacts under configured roots; see [fixture contract](fixture-execution.md) |
| `GET /operations` | Recorded action history |
| `GET /operations/UUID` | Action status and any saved investigation packet or proposal |
| `GET /operations/UUID/events`, `/packet.json`, `/packet.md`, `/packet.events` | Correlated action/packet artifacts |
| `GET /operations/UUID/proposal.json`, `/proposal.md`, `/proposal.events` | Validated proposal evidence, text and trace |
| `GET /issues/JOB/index.html` | Existing static issue inbox, regenerated without inference |
| `GET /issues/JOB/records/NAME.json`, `/locations/NAME.json` | Scoped issue-inbox evidence files |
| `GET /publications`, `/publications/ID`, `/publications/ID/json`, `/events` | Prepared owned-fixture publication bundles and journals; see [publication contract](draft-publication.md) |
| `POST /publication-actions` | Approve an exact saved bundle, or asynchronously publish/reconcile it; fields are `csrf`, `action`, `id`, `bundleHash` |
| `POST /actions` | Admit one typed operator action, then 303 to its status page |

POST bodies are form-encoded, at most 8 KiB, with unique fields. For `/actions`, required common
fields: `csrf`, UUID `requestId`, `jobId`, configuration `revision` hash and `action`.
The schema rejects extra fields. Host MUST match `127.0.0.1:PORT`; POST Origin MUST
match the same origin and its CSRF token. Cross-site fetch metadata is denied. No
CORS access is granted. Pages are no-store, nosniff, and use restrictive CSP.
Local processes are trusted; this is not authentication for remote users.

| Action | Additional fields | Effect and bound |
| --- | --- | --- |
| `run_now` | None | One new brief, at most four agent admissions, then configured SMTP delivery |
| `pause`, `resume` | None | Set a durable per-delivery-job admission flag |
| `retry` | `occurrence`, expected `attempts` 0–2 | Send a prepared or definitely rejected message, with existing three-attempt maximum |
| `investigate` | `briefId`, `briefHash`, issue `number` | One fresh issue read; readiness and eligible location, at most two agents |

| `propose` | `parentOperationId`, `packetId`, `packetHash`; feature-only `query` | One saved-packet proposal recipe, at most two agents |

## Rules

- Browser requests MUST NOT choose filesystem paths, recipients, SMTP parameters,
  providers, model IDs, source commits or commands. Configuration hashes freeze
  the operator-approved mapping at action admission; stale forms are rejected.
- Each action MUST be persisted before effects. Repeating its UUID and exact
  request returns the same record. Reusing a UUID with different input fails.
  One active console action is permitted; another gets an unavailable response
  rather than entering an unbounded queue.
- Investigation additionally deduplicates the configured revision, parent brief
  identity/hash and selected issue number. An existing failed/interrupted attempt
  is shown without repeating model calls. A new brief/configuration is a deliberate
  new selection, not semantic reuse of a prior judgment.
- Selection MUST refer to a validated completed/partial brief's captured open-issue
  membership. A matching title, model suggestion or fabricated number is insufficient.
  Source origin and pinned commit are checked before fetching/assessing. A fresh
  closed or invalid issue produces a skipped result, without model work. The fresh
  snapshot may differ from the earlier title sample and is saved explicitly.
- The existing [packet contract](investigation-packet.md) decides readiness and
  eligible location. This does not reproduce, diagnose, edit code, run tests, send
  issue comments or publish PRs. A packet's repository/issue/snapshot/commit/identity
  must match its action before serving it. Handoff deadline: 300 seconds; the
  packet retains its existing 240-second cooperative bound.
- Proposal admission MUST bind the saved parent action, job/revision, repository,
  issue snapshot, packet UUID/hash and source pin. Features require a bounded
  literal query; bugs reject it. Repeated identical parent/query selection returns
  the same operation, even after failure; a different query is a deliberate new
  preparation. The [proposal contract](change-proposal.md) controls eligibility,
  scope and the 240-second recipe bound. No provider/path/command can be supplied
  by this form. Artifacts live under `operations/UUID/proposal/`; deduplication
  identity is stored in `proposals/HASH.json`.
- `run_now` uses stable `ondemand-REQUEST_UUID` delivery identity. It neither
  consumes nor replaces the next scheduled occurrence. Replaying the same ID
  reuses the existing delivery and cannot repeat analysis. It remains available
  while the schedule is paused.
- Pause persists under `DELIVERY_STATE/controls/HASH.json`, keyed by delivery job
  ID. Each scheduled tick reads it before admission. Active work continues; the
  external timer is neither stopped nor modified. Resume affects later ticks,
  without automatically catching up skipped work or invoking a model.
- Retry rechecks expected attempt count under the delivery lock. Unknown sends,
  exhausted attempts, mismatched configurations and active/crash-held locks cannot
  retry through the browser. Reconciliation stays in the evidence-based delivery
  CLI. No button treats a missing success record as permission to resend.
- A storage failure after an effect can leave the action running/unknown. Child
  delivery/packet records remain authoritative. Restart MUST NOT replay unfinished
  actions. A crash-held `.action.lock` requires stopped-worker inspection before
  manual removal; interrupted action identities continue to resolve to their records.
- History examines up to 300 child directories per configured root and 500 action
  directories, reports truncation, and displays up to 100 briefs/deliveries per job.
  These are bounded views, not a complete archive index. Invalid records are counted
  and excluded. Conflicting content with the same brief UUID is excluded; exact
  canonical copies are deduplicated. Symlinks cannot escape an allowed artifact root.
- Configured next occurrence is calculated in the job's timezone, including DST.
  Systemd status is separately observed as active/inactive/unavailable/unconfigured.
  This does not prove future execution or receipt of email. Accepted SMTP remains
  distinct from captured mail, forwarding and inbox delivery.

## Derived artifacts

`operations/UUID/operation.json` is a strict v1 `operator-action`: request/hash,
start/end/status, optional fresh snapshot/commit and typed result. A packet is
saved under its operation directory. `handoffs/HASH.json` retains the deduplicated
investigation identity. The root `.action.lock` serializes mutations.

Common event export adds `operator.requested/completed/failed/unfinished`, optional
`operatorAction` and `issueNumber`. The parent is the selected brief; the child is
the resulting packet or delivery. For a proposal action the parent is its saved
packet and the child is the proposal workflow. `inputHash` identifies the typed request, not
raw issue text. Events omit CSRF tokens, private configuration, issue content and
transport diagnostics. An unfinished event remains unknown; no synthetic success
or inferred provider usage is emitted.

Fixture views implement [ADR-0015](../adr/0015-isolate-fixture-verification-and-scoped-patches.md)
and the [fixture design](../design/fixture-execution.md); browser actions cannot
launch patches, select runtimes or execute commands.

## References

- Proposal rationale: [ADR-0014](../adr/0014-draft-read-only-proposals-from-frozen-evidence.md).
- Rationale: [ADR-0012](../adr/0012-operate-saved-workflows-through-a-local-console.md).
- Context: [console design](../design/operator-console.md),
  [packages and recipes](../design/packages-and-recipes.md).
- Related: [inbox](inbox.md), [scheduled delivery](scheduled-delivery.md),
  [common events](agent-discovery.md).
- Phase/evidence: [backlog P9](../plans/backlog.md#phase-9--operator-console),
  [console trial](../plans/records/operator-console-2026-09-18.md).

Owned-fixture publication is now a separate [approved-bundle boundary](../design/draft-publication.md), under [ADR-0016](../adr/0016-publish-only-approved-fixture-bundles.md). Fixture results themselves retain `publication: not_authorized`.
