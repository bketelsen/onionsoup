---
name: agent-evaluation
description: Evaluate Onionsoup agent task quality and runtime reliability, instrument its runs, and assess whether its boundary can safely expand.
---

Evaluate the agent's promised decision separately from the software that carries it.
Schema checks and scripted models prove integration properties, not model judgment.
Use representative human-labeled inputs to measure actual task performance.

For a focused agent, choose cases around its decision boundary: sufficient evidence,
missing evidence, ambiguous evidence, out-of-scope requests, contradictory facts,
and instructions embedded in untrusted data. Check unsupported claims and question
usefulness as well as outcome accuracy. Keep expected results out of model context.

Test runtime invariants that matter: malformed model outputs cannot become success,
invented evidence is rejected, failures stay failures, retries terminate, and
cancelled work returns control. Test replay/idempotency only for supported behavior.
Do not build tests that merely repeat prompt wording.

Record run/input identifiers, source revision, prompt version, provider/model,
timestamps, logical steps, tool outcomes, termination reason, and provider usage.
Keep unknown measurements unknown. Retain enough context to investigate a bad
decision; keep credentials out of traces and mark issue text as sensitive local data.

Report fixture results, live evaluation results, and untested behavior separately.
For this first agent, require zero false-ready decisions and grounded evidence in
the checked-in corpus before a supervised pilot; also manually inspect questions.
This is an initial gate, not a statistical production claim. Expand the corpus
with real maintainer judgments before expanding autonomy or task scope.

Apply fixes to the narrowest failing boundary. A prompt issue does not automatically
justify a coordinator, persistent memory, more tools, or another agent.

See [factor mapping](../../docs/twelve-factors.md), especially factors 2, 3, 8, 10.
This evaluation workflow is an Onionsoup extension of Dex Horthy / HumanLayer's
12-Factor Agents. This skill text is licensed CC BY-SA 4.0.
