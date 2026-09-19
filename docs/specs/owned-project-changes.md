# Spec: Accepted owned-project implementation jobs

The `onionsoup-publication-filter-v1` profile implements one real feature in
`bketelsen/onionsoup`. It does not expose an arbitrary repository runner.

## Interface

Canonical schemas and functions live in `src/project-change/`. Commands:

```bash
npm run project-change -- propose --checkout REPO --commit SHA --output PROPOSAL_DIR --provider copilot
npm run project-change -- accept --checkout REPO --proposal PROPOSAL_DIR --mapping MAPPING.json --reason 'Existing user authorization and assistant scope decision'
npm run project-change -- dependencies --checkout REPO --commit SHA --output NEW_DEPENDENCY_DIR
npm run project-change -- execute --checkout REPO --proposal PROPOSAL_DIR --output NEW_RUN_DIR --runtime RUNTIME.json --dependencies DEPENDENCIES.json --seed FIXTURE_BUNDLE.json --provider copilot
npm run project-change -- prepare-publication --project RUN_DIR --config PUBLICATION_CONFIG --target-index 0
```

Output directories must be new and their parent directories must exist. The fixed
operator request is defined in `proposal.ts`. The seed is a previously validated
version-1 owned-fixture publication bundle; the host derives local test-only history
records for all publication statuses. Those seeds never authorize remote effects.
Their exact hash binds baseline and candidate checks. Raw outputs remain private.

| Artifact | Meaning |
| --- | --- |
| `proposal.json` | Original operator request, pinned context, requirements/proposal records, two reserved invocations and completion state |
| `job.json` | One-shot accepted proposal hash, compact result/provenance, base commit/tree, source and manifest hashes, allowlist, check mapping, profile hash and authority |
| `dependencies.json` | Manifest hashes, installed tree digest, Node/npm identities, registry, scripts-disabled policy and timestamp |
| `project.json` | Accepted job plus original proposal evidence, runtime/dependencies/seeds, baseline/candidate receipts, patch/review records, exact diff/commit/tree and outcome |
| Verification directory | Intent with exact command, private bounded observations and materialized read-only source/harness |
| Publication bundle v2 | Exact project workflow/hash, base/head/tree/diff/title/body, target/config identities; shared approval journal |

`mapping` is an array of `{criterionId, checks}`; every proposal criterion and every
fixed check must be represented. IDs are `default-history`, `status-filter`,
`invalid-filter`, `filter-controls`, `coverage-preserved`, `detail-unchanged`,
`documentation`, `typecheck`, `adjacent-console`. Mapping expresses the accepting
operator's judgment; structural coverage alone does not establish semantic relevance.

## Rules

- Only completed, matching requirements/proposal runs with `proposal_ready` and no
  blocking questions may be accepted. Original proposal records retain their
  read-only meaning. Acceptance is one-shot and names who accepted under which
  authority; it never claims independent human review on the assistant's behalf.
- Allowed files are exactly `src/publication/console.ts`, `src/console/server.ts`,
  `docs/specs/draft-publication.md`. Paths, source hashes, base, profile, lockfile,
  criterion map and proposal revision are frozen. Mutation of any invalidates the job.
- Patch/review input/result/run version 2 preserves version-1 fixture readers and
  calls. Capability manifests advertise the project profile separately. Workers
  have only `submit_result`; three steps, 180 seconds per call, two calls per
  implementation workflow, 15 minutes total. Proposal preparation has its existing
  separate two-call budget. Provider/model stay explicit: Copilot/Codex, Terra.
- No implementation conversation enters review. Edits must have exact before hashes
  and complete replacement contents; unknown paths, duplicates and no-ops fail.
- Candidate commit has exactly the accepted parent. Only allowed regular text files
  may differ. The exact patch must independently reconstruct the candidate Git tree.
- npm installation uses only public registry tarballs with SHA-512 integrity from
  the unchanged lockfile, `--ignore-scripts`, isolated cache/home and empty npm
  configuration. No target source or credentials enter provisioning. The installed
  dependency tree, including link targets and modes, is hashed and rechecked.
- Execution requires the existing rootless Podman/cgroup-v2 pinned runtime. No image
  pulls, network, credentials, Git metadata or writable host mount. Read-only source,
  dependencies, Node and host harness; UID 65534, no capabilities, no-new-privileges,
  private namespaces, 1536 MiB memory, 128 PIDs, two CPUs, 128 MiB noexec scratch,
  90 seconds and 512 KiB combined output. Forced cleanup targets the exact named
  container. A failed intent checkpoint prevents launch; cleanup failure is failure.
- The trusted harness starts the local HTTP server inside the isolated namespace,
  supplies status-varied saved history, observes list/filter/invalid/detail routes,
  runs TypeScript and selected original console tests. Models cannot edit checks.
  Host evaluation records each fixed check. Documentation has a limited deterministic
  check plus model/assistant review; it is not a semantic documentation proof.
- Baseline setup, default history, detail, coverage, types and adjacent tests must
  pass before patch admission. New-feature check failures remain explicit gaps.
  A candidate needs every check to pass and no blocking review findings.
- Preserve every failed/unfinished attempt. No automatic revision, resumed model
  call, merge or third-party publication. Local interrupted state requires inspection.
- Project publication is version 2 under the existing [publication contract](draft-publication.md).
  It must target the job's exact `bketelsen/onionsoup` base and candidate. Approval
  remains a separate exact-bundle effect authorization.

## Derived artifacts

Common workflow events expose accepted job, parent request and worker identities,
reservations, verification receipts and outcomes, without source, prompts, prose or
private paths. The generic `assertion_failed` trace value means checks failed;
the project record retains feature semantics and individual check results.
The publication console reads both bundle versions and their evidence.

## References

- Rationale: [ADR-0017](../adr/0017-execute-one-accepted-owned-project-proposal.md).
- Context: [owned-project design](../design/owned-project-changes.md).
- Plan: [Phase 5](../plans/investigation-to-pr.md#phase-5--one-real-owned-project-change).
- Dependency policy: [npm ci documentation](https://docs.npmjs.com/cli/v11/commands/npm-ci/).
