# Twelve factors, applied to Onionsoup

Living document. Rationale: [ADR-0004](../adr/0004-compose-bounded-maintenance-agents.md).
Contracts: [bug-readiness](../specs/bug-readiness.md).

## Overview

The twelve factors guide the boundaries, context, control flow, and evidence of the current agents.

## Design

Distilled from [Dex Horthy / HumanLayer's 12-Factor Agents](https://github.com/humanlayer/12-factor-agents)
at revision `d20c728368bf9c189d6d7aab704744decb6ec0cc`, read 2026-09-18.
This uses the written companion linked in REFERENCES.md; it is not a transcript
of the video. The guidance is modular, not a requirement to implement every
capability in every agent.

| Factor | Practical interpretation | Repository skill |
| --- | --- | --- |
| [1. Natural language to tool calls](https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-01-natural-language-to-tool-calls.md) | Have the model translate judgment into a typed intent that code can inspect. | agent-contract |
| [2. Own your prompts](https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-02-own-your-prompts.md) | Keep the actual prompt editable, versioned, and evaluable. | agent-context |
| [3. Own your context window](https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-03-own-your-context-window.md) | Deliberately select the model's view; stored history and model context need not be identical. | agent-context |
| [4. Tools are structured outputs](https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-04-tools-are-structured-outputs.md) | Separate action descriptions from execution, authorization, and validation. | agent-contract, agent-context |
| [5. Unify execution and business state](https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-05-unify-execution-state.md) | Keep what happened and the task outcome together; avoid parallel state machines that disagree. | agent-execution |
| [6. Launch/pause/resume with simple APIs](https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-06-launch-pause-resume.md) | Make lifecycle operations callable; persist meaningful waits instead of holding a worker open. | agent-execution |
| [7. Contact humans with tool calls](https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-07-contact-humans-with-tools.md) | Represent questions as explicit structured intents that a delivery adapter can route. | agent-execution |
| [8. Own your control flow](https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-08-own-your-control-flow.md) | Code owns transitions, effect boundaries, and stopping conditions. | agent-execution |
| [9. Compact errors into context](https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-09-compact-errors.md) | Give the model concise actionable feedback with finite opportunities to correct it. | agent-context, agent-execution |
| [10. Small focused agents](https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-10-small-focused-agents.md) | Make each job short and measurable, with limited capabilities. | agent-contract |
| [11. Trigger from anywhere](https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-11-trigger-from-anywhere.md) | Keep task semantics independent of CLI, webhook, schedule, or chat. | agent-contract |
| [12. Stateless reducer](https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-12-stateless-reducer.md) | Pass state explicitly and persist outside the worker. Stateless does not mean deterministic model output. | agent-execution |

The evaluation skill is our cross-cutting implementation practice, not a thirteenth
factor. The source's prefetch appendix also informs the one-snapshot input: gather
relevant evidence before asking the model instead of giving it a search loop.

### What the first agent implements

`src/triage.ts` assembles a bounded snapshot, runs AgentLayer with one typed tool,
and accepts only a validated result. A run record contains task data, execution
state, and outcome. The CLI persists admission and final state. Human questions
are structured output that ends this assessment; nothing is posted automatically.

There is no durable mid-run resume, delivery adapter, webhook server, shared queue,
team scheduler, or permission service. The task does not need them yet. A killed
process can leave a `running` record; inspect it and rerun the same snapshot under
a new run ID. This may repeat model cost but cannot repeat a GitHub mutation.
An updated issue is a new snapshot and assessment, not a continuation of stale
judgment. Add real pause/resume when a future task owns a wait or partial effects.

### A cohesive team, incrementally

The [“taco-bell orchestration” note](composable-agents.md) describes the composition
principle: reusable focused agents, multiple orchestrators, and different recipes
built from shared contracts. The inbox and portable packet now demonstrate two
consumers of that boundary.

The first concrete handoff now connects readiness to code-location and then to
the maintainer inbox. Host code admits matching ready bug reports, pins a Git
commit, and passes a versioned input with parent run ID and issue hash. It does
not pass the first agent's conversation. The second agent can only search/read
bounded source excerpts and submit candidate locations; code validates citations
and builds exact quotations. Its separate prompt, runtime hash, limits, run
record, and failure outcome make that boundary visible without a coordinator.

Future agents should likewise consume versioned artifacts with run identity,
input revision, evidence, and a clear owner for the next action. A separately
authorized comment-delivery component could consume proposed questions.
A duplicate finder or bug reproducer would have different evidence and tools.
Do not let agents enlarge their own authority by delegating.

Continue collecting real issue evidence and maintainer corrections before
expanding authority. Introduce each new agent at an actual handoff. Share contract
conventions and observability fields before sharing a runtime or inventing team roles.

### Attribution

This document and `.agents/skills/*/SKILL.md` adapt the source's ideas and are licensed
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), following its
content license. Changes include grouping factors into four skills, the concrete
OSS task boundary, validation/evaluation practices, and deferred-capability notes.
The new TypeScript implementation is original repository code; this attribution
does not select a repository-wide software license on the owner's behalf.

## Operational notes

Use the linked contracts for exact current schemas and budgets. Deferred capabilities remain proposals until separately implemented and evaluated.

## References

- Rationale: [ADR-0004](../adr/0004-compose-bounded-maintenance-agents.md).
- Context: [agent design](agents.md).
- Contracts: [readiness](../specs/bug-readiness.md), [code-location](../specs/code-location.md),
  [packet](../specs/investigation-packet.md), [inbox](../specs/inbox.md),
  [batch evaluation](../specs/batch-evaluation.md).
- Built in: [roadmap](../plans/roadmap.md#phase-1--readiness-foundation).
- Evidence: [evaluation plan](../plans/evaluations.md).
