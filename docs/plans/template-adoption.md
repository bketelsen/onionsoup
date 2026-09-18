# Plan: Retroactive template adoption

Apply [agentic-template at 12ef402](https://github.com/bketelsen/agentic-template/tree/12ef40281c7c430ac95ae997285716bb5dfe69a6)
to the existing repository on 2026-09-18. This is
[roadmap Phase 0](roadmap.md#phase-0--repository-conventions), preserving the agent
implementation and historical run records.

## Phase 1 — Canonical instructions and skills

- Apply [repository design](../design/repository-layout.md) and its
  [instruction-path contract](../specs/repository-layout.md#interface).
- **Done when:** AGENTS.md contains current Onionsoup guidance, tool paths are
  symlinks, and the four actual skills live in `.agents/skills/`. Implemented.

## Phase 2 — Organize and connect documentation

- Move flat docs into the four categories in the
  [repository design](../design/repository-layout.md); add decisions, the index,
  templates, and reciprocal links required by the
  [layout contract](../specs/repository-layout.md).
- **Done when:** current contracts, living designs, phased plans, and historical
  evidence are independently discoverable from the index, with valid local links.
  Implemented and checked on 2026-09-18.

## Phase 3 — Verify and publish

- Include the [documentation check](../specs/repository-layout.md#interface) in
  `npm run verify`, validate skills, run the credential-free demo, inspect the
  staged files for secrets, and push the reviewed migration to GitHub.
- **Done when:** checks pass, application source and dependency lockfile are
  unchanged by the migration, and the resulting commit is available on GitHub.

## Later / ideas

Use the templates for future additions. Agent behavior work resumes through the
[roadmap](roadmap.md), rather than being bundled into this organizational change.

## Open questions

None for this migration. The legacy root `skills` alias is retained by
[ADR-0003](../adr/0003-adopt-agentic-template-retroactively.md).

## References

- Rationale: [ADR-0001](../adr/0001-record-architecture-decisions.md),
  [ADR-0002](../adr/0002-agent-portable-instruction-surface.md),
  [ADR-0003](../adr/0003-adopt-agentic-template-retroactively.md).
- Implements: [repository design](../design/repository-layout.md),
  [repository contract](../specs/repository-layout.md).
