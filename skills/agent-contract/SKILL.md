---
name: agent-contract
description: Define or narrow an Onionsoup agent's task, public input/output contract, and handoff boundaries when adding an agent or changing its responsibility.
---

Start with a single observable decision or artifact. Name the consumer and the
smallest input that lets this agent produce it. If success requires unrelated
judgments, separate the jobs at a typed handoff before implementing a longer loop.

Write the contract before the prompt:

- Accepted input, provenance/revision, size limits, and missing-input behavior.
- Structured result, including insufficient evidence and out-of-scope outcomes.
- What counts as success, which evidence supports it, and what this agent cannot establish.
- Allowed capabilities, externally visible effects, and who owns the next action.
- Step/time limits and the conditions that end this task.

Use the model for semantic judgment; use code for identifiers, validation,
permissions, routing, and executing effects. Model-selected tool arguments are
proposals that must pass validation. Typed interfaces do not by themselves prove
the truth of the model's claims.

Publish a versioned data contract independent of the trigger and provider. A CLI,
webhook, or future colleague should submit the same input and consume the same
result. Preserve run and input revision identifiers through handoffs. Avoid passing
another agent's whole conversation when a small result and evidence will do.

For this repository, bug-readiness ends with an assessment of one snapshot.
Finding duplicates, reproducing bugs, setting priority, and posting comments are
separate responsibilities. Add a new agent only after there is a concrete consumer
and measurable task; do not build a supervisor in anticipation of one.

See [factor mapping](../../docs/twelve-factors.md), factors 1, 4, 10, 11.
Adapted from Dex Horthy / HumanLayer's 12-Factor Agents; this skill text is
licensed CC BY-SA 4.0, with repository-specific contracts and boundaries added.
