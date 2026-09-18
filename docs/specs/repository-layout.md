# Spec: Repository layout and documentation checks

This contract governs canonical instruction paths, documentation discovery, and
the local check used by contributors and coding agents.

## Interface

| Path | Required representation / exact symlink target |
| --- | --- |
| `AGENTS.md` | Regular canonical Markdown file |
| `.agents/skills/` | Real directory containing the four agent skills and a template |
| `CLAUDE.md` | Symlink to `AGENTS.md` |
| `GEMINI.md` | Symlink to `AGENTS.md` |
| `.github/copilot-instructions.md` | Symlink to `../AGENTS.md` |
| `.claude/skills` | Symlink to `../.agents/skills` |
| `skills` | Compatibility symlink to `.agents/skills` |

`npm run check:docs` invokes [scripts/check-docs.mjs](../../scripts/check-docs.mjs).
It exits zero on success and nonzero with file-specific diagnostics on failure.
`npm run verify` includes this command before type checking and tests.

## Rules

- Documentation MUST live in `docs/adr/`, `docs/design/`, `docs/specs/`, or
  `docs/plans/`, apart from the entry index `docs/README.md`.
- The index MUST link every Markdown document beneath `docs/`, including templates
  and dated evidence appendices under `docs/plans/records/`.
- Canonical instruction paths MUST have the representations above; symlink
  destinations MUST resolve. Edits go to canonical files.
- Relative inline Markdown links in root instructions, README, REFERENCES, docs,
  and actual skills MUST resolve inside the repository. Markdown heading anchors
  MUST resolve, including duplicate-heading suffixes. External URLs are not fetched.
- Fenced examples, comments, and `TEMPLATE.md`/`TEMPLATE/SKILL.md` placeholders are
  excluded from link validation. A missing target beneath ignored `runs/` is
  allowed: published evidence cannot require local run records to be present.
- New documents MUST use their category template and the cross-link rules in
  [AGENTS.md](../../AGENTS.md). These semantic relationships are reviewed by a
  contributor; the checker validates their local destinations, not their meaning.
- Historical reports MUST keep their recorded versions and outcomes. Relocation
  does not establish current task accuracy or independent human acceptance.

## Derived artifacts

The docs index is curated, not generated. Instruction and skill aliases resolve
the canonical content without introducing another copy. No runtime agent schema,
prompt, or raw run artifact is derived from this layout contract.

## References

- Rationale: [ADR-0001](../adr/0001-record-architecture-decisions.md),
  [ADR-0002](../adr/0002-agent-portable-instruction-surface.md),
  [ADR-0003](../adr/0003-adopt-agentic-template-retroactively.md).
- Context: [repository design](../design/repository-layout.md).
- Delivery: [template adoption](../plans/template-adoption.md),
  [roadmap — Phase 0](../plans/roadmap.md#phase-0--repository-conventions).
