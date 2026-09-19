# Spec: Read-only change proposals, version 1

This contract governs feature preparation, the shared bug/feature proposal agent,
and their deterministic recipe. It implements
[ADR-0014](../adr/0014-draft-read-only-proposals-from-frozen-evidence.md) within the
[change workflow design](../design/investigation-to-pr.md). Exact strict schemas
live in [contracts.ts](../../src/change-proposal/contracts.ts).

## Interface

```sh
# Bug: reuse one validated saved investigation packet.
npm run proposal -- PATH/packet.json --provider copilot --output NEW_DIRECTORY
# Feature: the packet preserves feature_request / not_applicable.
npm run proposal -- PATH/packet.json --provider copilot --output NEW_DIRECTORY \
  --checkout PATH/TO/CLONE --query addTokenUsage
npm run proposal -- render DIRECTORY
```

The CLI requires explicit Copilot/Codex provider selection and uses Terra. Output
admission requires a new directory. Render never invokes a provider or rewrites
original evidence. The [console](operator-console.md) also admits proposals from
its completed investigation actions with matching configuration and source pin.

Callable agents in [agents.ts](../../src/change-proposal/agents.ts):
`extractFeatureRequirements(input, options)` and `draftChangeProposal(input, options)`.
Options require caller-selected `model`, `provider`, `modelId`; optional cooperative
`signal` and awaited `checkpoint`. Results are saved `ProposalAgentRun` records.
The recipe `createChangeProposal(packet, options)` freezes the validated parent,
its SHA-256 JSON hash, issue identity and full source commit.

| Artifact | Fields and meaning |
| --- | --- |
| Requirements input | v1 issue snapshot; evidence IDs `issue:title` and nonempty `issue:body` |
| Requirements result | v1 status `sufficient_for_proposal` or `needs_information`; user need, scenarios, constraints, non-goals, questions |
| Shared proposal input | v1 `changeKind: bug_fix|feature`, parent UUID/hash, issue, commit, source excerpts and limits; bug readiness summary or feature requirements |
| Proposal result | v1 status `proposal_ready|needs_information`, outcome, changes, non-goals, criteria, verification plan, compatibility/migration/docs claims, questions, risks |
| Claim | Text, `basis: reported|proposed`, 1–12 unique known evidence IDs |
| Criterion | Unique `AC1`-style ID and claim |
| Verification check | Criterion IDs, check claim, kind and baseline expectation; a plan, never execution evidence |
| Question | Text, known evidence IDs, `blocking` boolean |
| Workflow | v1 `kind: change-proposal`, original packet/hash, preparation, stages/reservations, execution, budget, timestamps/status; host-owned acceptance/verification |

## Rules

- Eligibility MUST preserve the packet's classification: a ready bug or a feature
  request with completed readiness, in a completed/partial packet. Support,
  unclear and incomplete-bug outcomes do not enter this stage. No feature calls
  the bug-only code locator. No agent accepts or rejects project scope.
- Bugs reuse validated packet quotes and uncertainties, with direct/adjacent test
  relevance preserved. Historical tests without relevance remain unassessed.
  Features run a requirements agent and one source query (1–160 literal characters),
  then inspect at most three distinct matching files, at most 25 lines and 6,000
  characters each. Search previews are not citations. Failed inspections remain
  explicit; excerpts carry `unassessed_search_lead` relevance. No repository code
  is executed. Missing or irrelevant context requires more information.
- Requirements with blocking questions MUST remain `needs_information`; sufficient
  requirements need a scenario. The shared input revalidates these invariants.
  A proposal with blocking questions MUST remain `needs_information`; that status
  MUST have a blocking question. Mixed scope should produce a scope-split question.
- Every ready proposal MUST have changes, source context, unique acceptance
  criteria and checks covering every criterion. Feature preparation MUST be
  sufficient. Bugs require regression checks; features require acceptance and
  compatibility checks. Features MUST NOT use `reported_failure` as their baseline.
  Other expectations: `capability_absent`, `existing_behavior`, `not_applicable`,
  `unknown`. These are planned expectations, not measured outcomes.
- Proposal prompts v2/v3 additionally requires a source citation in scope or
  verification. A citation's relevance and support remain model judgments; known
  IDs alone cannot establish correctness. Prompt v3 asks the model to assess relevance itself and distinguish blocking
  behavior decisions from advisory implementation details. Historical v1/v2 runs remain readable
  under their original validation and MUST NOT be relabeled as current-prompt evidence.
- Acceptance MUST remain `not_recorded`; verification MUST remain `not_executed`.
  No patch, execution policy or publication authority is inferred from a ready result.
- Model context is bounded to 60,000 characters. Recognizable credential strings
  cause rejection before invocation, not silent evidence mutation. All issue/source
  content is untrusted data. This filter is not a general secret detector.
- The recipe reserves from one two-invocation allowance before initializing a
  provider. Bugs spend one; features spend two. Each agent has three model steps
  and a 90-second cooperative deadline; the recipe has 240 seconds. No automatic
  task retries, unbounded correction loop or durable resume. Failed/interrupted
  child execution stops downstream admission. Provider costs remain unknown.
- Initial and final child snapshots and reservations MUST be persisted before
  continuation. Storage failure stops the recipe and preserves the last durable
  state as authoritative; unfinished means unknown. Completed runtime means valid
  tool submission and successful stop condition, not independently accepted quality.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| `proposal.json` | Authoritative frozen parent, preparation, child records and reservations |
| `proposal.md` | Escaped readable scope, checks, questions, limitations and provenance |
| `events.json` | Allowlisted shared workflow events, parent correlation, reservations, child status and usage |
| Capability manifests | Generated schemas, entry points, limits, prompts and effects for both agents |

## References

- Rationale: [ADR-0013](../adr/0013-converge-bugs-and-features-on-a-shared-change-proposal.md), [ADR-0014](../adr/0014-draft-read-only-proposals-from-frozen-evidence.md).
- Context: [change workflow design](../design/investigation-to-pr.md).
- Plan: [read-only proposal phase](../plans/investigation-to-pr.md#phase-1--read-only-change-proposals).
- Related: [packet](investigation-packet.md), [discovery/events](agent-discovery.md), [console](operator-console.md).
