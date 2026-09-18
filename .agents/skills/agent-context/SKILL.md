---
name: agent-context
description: Build or tune an Onionsoup agent's prompt, tool schemas, and bounded context from task evidence; use when changing what the model sees or returns.
---

Treat the system prompt and context builder as reviewable code. Keep the prompt
literal and versioned; identify the model/provider separately. Do not silently
inherit a general coding-agent prompt or a framework's growing default tool bag.

Assemble the smallest sufficient view from the task's input, relevant evidence,
validated tool results, and unresolved errors. Preserve source/revision identifiers.
Keep durable history distinct from the selected model view; owning context means
you may rebuild that view without destroying the audit record.

Place issue bodies, comments, retrieved documents, and human-supplied report text
in data messages. Explicitly distinguish these from instructions. Filter secrets
before model invocation. Enforce input bounds in code; do not silently truncate
away facts that could reverse the decision. Reject oversized snapshots or return
an explicit partial-context outcome if the contract supports it.

Model actions should use narrow schemas. Separate each tool's interface from its
executor, and check evidence and business invariants in code after schema parsing.
Do not infer a successful action from prose or an unexecuted tool call. Give the
model only the tools needed for this task.

For recoverable errors, return a short error code, the relevant field, and a
possible correction. Do not repeatedly append full traces or credentials. Keep
correction attempts bounded by the execution contract. Do not use compaction as a
substitute for reducing an oversized task.

When modifying a prompt, compare behavior on saved cases, including sparse prose,
template placeholders, and instruction injection inside source material. Change
the prompt version when its behavior changes.

See [factor mapping](../../../docs/design/twelve-factors.md), factors 2, 3, 4, 9.
Adapted from Dex Horthy / HumanLayer's 12-Factor Agents; this skill text is
licensed CC BY-SA 4.0, with repository-specific evidence checks added.
