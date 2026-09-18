# Plan: Onionsoup roadmap

Status as of 2026-09-18. This roadmap separates implemented PoC capabilities from
future qualification. The [evaluation plan](evaluations.md) holds the dated
evidence; implementation completion alone does not establish task accuracy.

## Phase 0 — Repository conventions

- Adopt the [repository design](../design/repository-layout.md) and
  [layout contract](../specs/repository-layout.md) through the
  [template adoption plan](template-adoption.md).
- **Done when:** canonical instructions and skills, indexed docs, and the local
  documentation check are committed and available from GitHub.

## Phase 1 — Readiness foundation

- Implemented: one bounded assessment per issue, separate request kind/readiness,
  grounded evidence, focused questions, explicit failure records, subscription
  adapters, and historical v1 compatibility.
- Implements [agent design](../design/agents.md),
  [twelve factors](../design/twelve-factors.md), and
  [readiness contract](../specs/bug-readiness.md).
- **Done when:** a caller can produce and inspect a validated v2 assessment or an
  explicit failed run without granting GitHub mutation authority. Implemented;
  independent accuracy qualification remains separate.

## Phase 2 — Read-only maintainer workflow

- Implemented: bounded issue intake, content freshness, durable attempts, and local
  presentation. No maintainer grading is required to use the inbox.
- Implements [agent design](../design/agents.md), [validation](../design/validation.md),
  [inbox](../specs/inbox.md), and [batch evaluation](../specs/batch-evaluation.md).
- **Done when:** a refresh reuses unchanged reports and presents assessments,
  questions, waiting work, and failures without modifying GitHub. Implemented.

## Phase 3 — Grounded code and test locations

- Implemented: a separate agent, pinned Git source, bounded search/read tools,
  citation validation, test-read reserve, v2 host-generated overviews, and grouped
  correction feedback. Historical v1 records remain readable.
- Implements [agent design](../design/agents.md),
  [validation](../design/validation.md), and
  [code-location contract](../specs/code-location.md).
- **Done when:** ready reports can yield inspectable code/test starting points or
  explicit failures, with all accepted citations tied to inspected source.
  Implemented; useful test selection is not guaranteed by exact citations.

## Phase 4 — Portable composition

- Implemented: a second consumer exports Markdown and JSON using the same two
  agents without depending on inbox storage or UI.
- Implements [composable agents](../design/composable-agents.md),
  [agent design](../design/agents.md), and
  [packet contract](../specs/investigation-packet.md).
- **Done when:** packets preserve original assessment/location records, parent
  identities, uncertainties, and partial failures and can render without a model.
  Implemented. External orchestration integrations remain future work.

## Phase 5 — Explicit test relevance (planned)

- Next bounded exploration: distinguish direct behavior coverage, adjacent tests,
  and unfinished test search; avoid presenting a precisely quoted weak test as
  strong coverage. This is a proposal, not a current output field.
- Extend [agent design](../design/agents.md), [validation](../design/validation.md),
  and [code-location contract](../specs/code-location.md) together after recording
  the contract decision. Use the [evaluation plan](evaluations.md#phase-4--test-relevance-qualification-planned).
- **Done when:** a frozen, small Terra-only trial reports relevance separately from
  citation validity, preserves failed attempts, and shows whether the change
  improves useful test selection without broadening agent authority.

## Later / ideas

- Demonstrate an actual external consumer before adding a universal coordinator.
- Revisit provider/model comparison as a structured study. Local inference remains
  a reasonable exploration route, currently deferred.
- Add focused agents only when evidence identifies a separate useful job and its
  public contract. Do not turn location into diagnosis or repair.

## Open questions

- Before Phase 5, determine how relevance should be represented and which evidence
  supports each category. Record any contract change in a new ADR.
- Independent maintainer acceptance remains unmeasured for some historical trials;
  assistant reviews cannot supply that measurement.

## References

- Rationale: [ADR-0003](../adr/0003-adopt-agentic-template-retroactively.md),
  [ADR-0004](../adr/0004-compose-bounded-maintenance-agents.md).
- Implements: [repository design](../design/repository-layout.md),
  [agent design](../design/agents.md), [validation](../design/validation.md), and
  the contracts linked from each phase.
- Evidence and limits: [evaluation plan](evaluations.md).
