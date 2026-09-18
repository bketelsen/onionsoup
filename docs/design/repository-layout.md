# Repository layout and instruction discovery

Living document. Rationale: [ADR-0001](../adr/0001-record-architecture-decisions.md),
[ADR-0002](../adr/0002-agent-portable-instruction-surface.md), and
[ADR-0003](../adr/0003-adopt-agentic-template-retroactively.md).
Contracts: [repository layout](../specs/repository-layout.md).

## Overview

Onionsoup uses the owner's agentic-template conventions around the existing
TypeScript application. Instructions and skills have one editable home. The docs
index separates current architecture and contracts from decisions, plans, and
historical evaluation evidence.

## Design

`AGENTS.md` routes coding work to four skills in `.agents/skills/`. Tool-specific
instruction paths are symlinks. The root `skills` symlink retains compatibility
with older local skill catalogs; `.agents/skills/` is the real directory.

| Path | Contents |
| --- | --- |
| `src/`, `test/`, `scripts/`, `examples/` | Application, tests, local utilities, synthetic inputs |
| `docs/adr/` | Accepted rationale and subsequent decisions |
| `docs/design/` | Current mechanisms and architecture |
| `docs/specs/` | Exact public and repository contracts |
| `docs/plans/` | Phased work and observable completion criteria |
| `docs/plans/records/` | Dated evidence appendices linked from the evaluation plan |
| `runs/`, `.local/` | Ignored local records, credentials, source clones, and scratch work |

The retroactive migration moved the flat factor, composition, and validation docs
into `design/`; readiness, location, packet, inbox, and batch contracts into
`specs/`; and dated reports into `plans/records/`. Their prior paths remain in Git
history. Current links point directly to canonical files rather than redirect docs.
Raw run records and agent runtime files were not migrated or rewritten.

Each category includes a starter `TEMPLATE.md`. Historical reports retain their
original findings and gain navigation back to their plan. New reports use the
record appendix template. All documents, including templates, appear in
[the documentation index](../README.md).

## Operational notes

Run `npm run check:docs` while editing and `npm run verify` before completion.
The checker reads repository Markdown and filesystem metadata; it makes no network
requests and needs no credentials or run records. Templates intentionally contain
placeholder links. Links into ignored `runs/` are optional evidence pointers; the
published report must stand on its own without those files.

Symlinks require a filesystem and Git configuration that preserve them. On native
Windows use `core.symlinks=true` or WSL, as recorded in ADR-0002. Do not replace
links with independently edited copies.

## References

- Rationale: [ADR-0001](../adr/0001-record-architecture-decisions.md),
  [ADR-0002](../adr/0002-agent-portable-instruction-surface.md),
  [ADR-0003](../adr/0003-adopt-agentic-template-retroactively.md).
- Contract: [repository layout](../specs/repository-layout.md).
- Built in: [roadmap — Phase 0](../plans/roadmap.md#phase-0--repository-conventions),
  [template adoption](../plans/template-adoption.md).
