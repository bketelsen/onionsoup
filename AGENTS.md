# Onionsoup

Build focused OSS maintenance agents using AgentLayer. Keep one job per agent and
prove it useful before adding coordination infrastructure. Start at
[docs/README.md](docs/README.md) for designs, contracts, evidence, and plans.

`AGENTS.md` is canonical. `CLAUDE.md`, `GEMINI.md`, and
`.github/copilot-instructions.md` link here; `.claude/skills` links to
`.agents/skills/`. Edit canonical files only and keep instructions tool-agnostic
([ADR-0002](docs/adr/0002-agent-portable-instruction-surface.md)). The root `skills`
symlink preserves older references.

## Skills (follow these for common tasks)

Read the applicable skill before doing that work:

- Define responsibility or handoffs: [agent-contract](.agents/skills/agent-contract/SKILL.md).
- Develop prompts, tools, or context: [agent-context](.agents/skills/agent-context/SKILL.md).
- Implement execution, recovery, or human handoffs: [agent-execution](.agents/skills/agent-execution/SKILL.md).
- Evaluate behavior, instrument runs, or decide readiness: [agent-evaluation](.agents/skills/agent-evaluation/SKILL.md).

Additional skills for the twenty-factor follow-through:

- Publish a discoverable agent capability: [agent-capabilities](.agents/skills/agent-capabilities/SKILL.md).
- Make a complete workflow inspectable: [workflow-observability](.agents/skills/workflow-observability/SKILL.md).
- Bound the whole workflow: [workflow-budgets](.agents/skills/workflow-budgets/SKILL.md).
- Record a reproducible execution configuration: [agent-release-manifest](.agents/skills/agent-release-manifest/SKILL.md).
- Keep delegated authority explicit: [agent-authority](.agents/skills/agent-authority/SKILL.md).
- Persist the workflow at real recovery boundaries: [workflow-durability](.agents/skills/workflow-durability/SKILL.md).
- Automate useful quality feedback: [agent-quality-review](.agents/skills/agent-quality-review/SKILL.md).
- Share explicit repository knowledge: [repository-knowledge](.agents/skills/repository-knowledge/SKILL.md).

Deferred capabilities remain deferred unless the task calls for them; loading a
skill does not authorize new effects or infrastructure.

Start new skills from [.agents/skills/TEMPLATE/SKILL.md](.agents/skills/TEMPLATE/SKILL.md).

## Code conventions (live — the code exists)

- Select provider and model explicitly at the application edge; prefer Copilot
  and Codex subscriptions. See [providers.ts](src/providers.ts).
- Use `gpt-5.6-terra` for current development evaluations and new batches, as in
  [evaluation-policy.ts](src/evaluation-policy.ts). Keep historical comparisons
  readable; defer a new model-comparison harness.
- Separate request kind from bug readiness. Classification must not imply project
  acceptance or rejection. Preserve v1 results without relabeling them. See
  [contracts.ts](src/contracts.ts) and [triage.ts](src/triage.ts).
- Dispatch code-location only for matching ready bug reports and a pinned Git
  commit. Read Git blobs through the bounded source adapter; do not execute target
  repository code. See [location-agent.ts](src/location-agent.ts) and
  [location-source.ts](src/location-source.ts).
- Validate citations against inspected evidence, preserve explicit failed attempts,
  and use host-generated v2/v3 overviews. Keep legacy v1/v2 records readable. See
  [location-contracts.ts](src/location-contracts.ts) and
  [location-record.ts](src/location-record.ts).
- Compose agents through versioned artifacts and callable functions; retain parent
  run identities and provenance. See [packet.ts](src/packet.ts).
- Run `npm run verify` for code or documentation changes. It checks documentation,
  types, and tests. Use `npm run demo` for a credential-free AgentLayer smoke test.
  Scripted model tests do not establish task accuracy.

## Repository boundary

Keep credentials, private keys, raw runs, local clones, and dependencies out of
Git. See [.gitignore](.gitignore). Never log credentials. Run live evaluations only
with a configured subscription; the local-provider exploration remains deferred.

Do not broaden readiness into general triage, debugging, or GitHub mutation.
Code-location suggests grounded code/test starting points; it must not diagnose
bugs, execute repository code, implement fixes, or mutate GitHub. The inbox and
packet are consumers of these bounded agents, not new agent authorities.

The [factor mapping](docs/design/twelve-factors.md) records consciously deferred
capabilities. Public contracts are [readiness](docs/specs/bug-readiness.md),
[code-location](docs/specs/code-location.md), and
[investigation packets](docs/specs/investigation-packet.md).

## Documentation rules

Every new document starts from its category's `TEMPLATE.md`:

- `docs/adr/`: why we decided. Accepted ADRs are immutable; reversals use a new
  ADR and mark the old one Superseded.
- `docs/design/`: how it fits together. Update living designs to match reality.
- `docs/specs/`: exact contracts. Behavioral changes accompany implementation.
- `docs/plans/`: order of work. Every phase has a demonstrable **Done when**.

Dated evaluation reports live in `docs/plans/records/` as evidence appendices of
[the evaluation plan](docs/plans/evaluations.md). Preserve historical versions,
findings, and limitations; do not rewrite them as current qualification.

### Cross-linking is mandatory

Maintain links in both directions when adding or changing documents:

- ADRs link the designs/specs they shape and prior ADRs they build on.
- Designs link their rationale ADRs, contract specs, and implementing roadmap phase.
- Specs link their motivating ADRs and the design showing where they fit.
- Every plan phase links the design/spec it implements. Resolved architectural
  questions become ADRs.

Use relative links with valid targets and section anchors. `npm run check:docs`
checks local links, the index, document placement, and instruction symlinks;
reviewers also verify that cross-links accurately explain the relationships.

### Housekeeping

- Index every new document in [docs/README.md](docs/README.md).
- Record significant decisions in an ADR first, then update affected designs/specs.
- Use absolute dates in documentation.
- Edit the canonical `.agents/skills/` files, not separate tool-specific copies.
