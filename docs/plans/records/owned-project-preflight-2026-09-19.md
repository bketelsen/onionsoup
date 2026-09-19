# Evaluation record: Owned-project execution preflight — 2026-09-19

Historical evidence appendix to [the evaluation plan](../evaluations.md). This
records qualification before the final live feature candidate, not a completed
real-project repair claim. Review was scripted and by the assistant; no independent
human code-quality acceptance occurred.

## Method and boundaries

The user authorized publication-status filtering as the first Onionsoup project
change, through an accepted proposal, isolated execution, separate review and draft
publication. Three existing files are editable. The proposed behavior and fixed
checks are in the [project contract](../../specs/owned-project-changes.md).

A live Copilot/Terra requirements/proposal pair at
`bf1e1bab3ac707e2756a4246e8f1545698924842` produced five criteria with no blocking
questions. The assistant accepted those criteria under the user's explicit scope,
not as independent human review. No candidate was generated in this first attempt.
The accepted artifact remains tied to its original profile hash; subsequent runner
changes invalidate it rather than silently carrying its authority forward.

## Results and evidence

- Scripted tests exercise proposal/acceptance hashes, criterion coverage, compact
  context without prior conversations, edit allowlists, exact commit/diff
  reconstruction, failed checkpoints/setup/checks, v1/v2 publication compatibility,
  dependency digests, Git-metadata exclusion and common events.
- A real container baseline at the earlier publication implementation preserved
  default history, coverage, details, types and adjacent behavior, while reporting
  the absent filtering behavior as new-feature check failures.
- Mapping the live proposal exposed missing empty-result and JSON/events checks.
  Those scenarios were added before allowing an implementation candidate.
- The expanded Onionsoup source then exhausted the compiler heap under the initial
  768 MiB container policy. HTTP/adjacent behavior passed; typechecking failed.
  The private receipt and observations remain under `.local/project-change/baseline-debug/`.
  This was not counted as a verified baseline or model failure.
- The qualified profile uses 1536 MiB total memory and an explicit 1024 MiB compiler
  heap, with the same network, filesystem, PID, CPU, time and output restrictions.
  Full `npm run verify` then passed all 185 tests, including real fixture and project
  sandbox checks, with zero skips.
- Dependency provisioning initially failed because npm refuses loading `/dev/null`
  as both global and user config. A distinct empty global config corrected setup.
  The unsuccessful directory was retained. Successful `npm ci --ignore-scripts`
  used npm 11.17.0, pinned Node 24.19.0 and the lockfile's public-registry integrities.
  Installed dependency tree digest:
  `49b88bbb722fae21173b9693b42eebe1cbe5c07d16709ee377dda1253f3b84af`.

## Limitations and next step

This preflight does not establish feature implementation quality. The final live
proposal must bind the new committed base/profile, then pass candidate checks and
separate review before publication. Its private project/publication artifacts and
public draft body will retain exact run, proposal, job, commit and receipt identities.
No additional model comparison, local inference trial or external repository write
was performed. The code shares the host kernel and has finite checks, not hostile
multi-tenant qualification or a guarantee against output forgery.

## References

- Plan phase: [evaluation Phase 15](../evaluations.md#phase-15--accepted-owned-project-proposal), [change-workflow Phase 5](../investigation-to-pr.md#phase-5--one-real-owned-project-change).
- Context: [owned-project design](../../design/owned-project-changes.md).
- Contract: [accepted project jobs](../../specs/owned-project-changes.md).
- Rationale: [ADR-0017](../../adr/0017-execute-one-accepted-owned-project-proposal.md).
