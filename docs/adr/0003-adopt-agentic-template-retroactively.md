# 0003 — Adopt agentic-template without changing agent behavior

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

Onionsoup already has working agents, public contracts, skills, and dated quality
reports. Their flat documentation layout makes current contracts, historical
evidence, and future work difficult to distinguish. The repository owner requested
retroactive adoption of their agentic-template and publication to GitHub.

## Decision

Adopt [agentic-template at 12ef402](https://github.com/bketelsen/agentic-template/tree/12ef40281c7c430ac95ae997285716bb5dfe69a6)
with one canonical instruction file and real `.agents/skills/` directory. Preserve
the old `skills/` path as a compatibility symlink. Categorize documentation into
ADRs, living designs, exact specs, and phased plans; index every canonical document.
Keep dated evaluation reports under `docs/plans/records/` as evidence appendices
of the evaluation plan. Preserve their historical findings and versions.

Add a local documentation check to the existing `npm run verify` recipe. It checks
relative links/anchors, the index, taxonomy, and canonical symlinks. Intentional
template placeholders and optional ignored run artifacts are distinguished from
required repository files. Do not change prompts, contracts, source execution,
dependencies, or persisted run data as part of this migration.

## Consequences

- Coding tools share the same instructions and skills without copied variants.
- Current interfaces and historical evidence have distinct, navigable homes.
- Old flat documentation URLs move; Git history retains the original paths.
- Templates and documentation checks add a small maintenance obligation.
- Raw run files remain local and ignored. Their absence in a fresh checkout is
  valid; the published reports still explain the evidence and its limitations.

## Alternatives considered

- **Replace Onionsoup with a fresh template:** loses the implemented work and
  evidence. Rejected.
- **Copy conventions without moving or linking existing docs:** preserves the
  discovery problem and creates competing instruction/skill copies. Rejected.
- **Rewrite historical reports as current design:** risks implying that old
  results qualify current agents. Rejected.

## References

- Builds on: [ADR-0001](0001-record-architecture-decisions.md),
  [ADR-0002](0002-agent-portable-instruction-surface.md).
- Shapes: [repository design](../design/repository-layout.md),
  [repository contract](../specs/repository-layout.md),
  [adoption plan](../plans/template-adoption.md),
  [evaluation plan](../plans/evaluations.md), [roadmap](../plans/roadmap.md).
