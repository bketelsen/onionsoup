---
name: writing-plans
description: Use when you have an agreed design or clear requirements for a multi-step change in your repository, before touching the desk - writes a plan of small tasks with exact files, tests and verification commands and submits it with onionsoup_submit_plan for the person's approval.
---

# Writing Plans

## Overview

Write a plan that an implementer with zero context for this repository, and questionable taste, can follow. Say which files each task touches, the code, the tests, the docs to check, and how to verify it. Break it into bite-sized tasks. DRY. YAGNI. TDD.

Assume the implementer is skilled but knows almost nothing about this toolset or problem domain, and not much about good test design. Remember that the `onionsoup-implementer` subagents who will run it cannot see your notebook: put every fact and decision they need into the plan.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Where the plan goes:** you submit it with `onionsoup_submit_plan`. You do not save it in the repository, and you never mark it approved yourself. Host code records the approval.

## When You Do Not Need a Plan

Small, clear, direct changes skip the plan: a typo, a one-line fix, a bounded change the person already agreed in chat. Edit the desk, verify, and call `onionsoup_propose_changes`. The person may also say a plan is unnecessary. Anything with several tasks, design choices or risk gets a plan.

## Scope Check

If the design covers several independent subsystems, it should have been split during brainstorming. If it was not, write one plan per subsystem; each plan should produce working, tested software and one pull request on its own. For a repository group, name the `repository` the plan targets, or split per repository.

## File Structure

Before defining tasks, map which files will be created or modified and what each is responsible for. This is where decomposition gets locked in.

- Each file has one clear responsibility and a well-defined interface.
- Prefer smaller, focused files over large ones that do too much.
- Files that change together live together. Split by responsibility, not by technical layer.
- In existing code, follow established patterns and the repository's code rules. If a file you must modify has grown unwieldy, a split in the plan is reasonable.

## Task Right-Sizing

A task is the smallest unit that carries its own test cycle and is worth a fresh reviewer's gate. Fold setup, configuration, scaffolding and documentation into the task whose deliverable needs them. Split only where a reviewer could reject one task while approving its neighbor. Each task ends with an independently testable deliverable.

## Bite-Sized Steps

Each step is one action (two to five minutes):

- "Write the failing test"
- "Run it to make sure it fails"
- "Implement the minimal code to make the test pass"
- "Run the tests and make sure they pass"

There is no commit step. Changes accumulate on the desk; host code commits them after `onionsoup_propose_changes`.

## Plan Header

Every plan starts with this header:

```markdown
# [Feature Name] Implementation Plan

> **For the execution session:** Use the subagent-driven-development skill to run this plan task by task, then end with onionsoup_propose_changes for this item. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [One sentence describing what this builds]

**Architecture:** [Two or three sentences about the approach]

**Tech Stack:** [Key technologies and libraries]

**Verification:** [The repository's verification commands, exactly as your prompt lists them]

## Global Constraints

[Project-wide requirements the design agreed: version floors, dependency limits, naming and copy rules, platform requirements, decisions the person made. One line each, exact values verbatim. Every task implicitly includes this section.]

## Assumptions

[Only for work you designed without the person: each assumption you made, one line each, so the approver can correct it. Omit when the person agreed the design.]

## Review Focus

[The five inputs or failure modes the design implies but no task's tests exercise that are most likely to bite someone using this software. One line each: the input or condition, and the behavior a reasonable person would expect. Then add the test that pins each line to the task that owns the code.]

---
```

## Task Structure

````markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.ts`
- Modify: `exact/path/to/existing.ts:123-145`
- Test: `test/exact/path/to/file.test.ts`

**Interfaces:**
- Consumes: [what this task uses from earlier tasks, with exact signatures]
- Produces: [what later tasks rely on: exact names, parameter and return types. An implementer sees only its own task; this block is how it learns the names its neighbors use.]

- [ ] **Step 1: Write the failing test**

```typescript
test('rejects an empty name', () => {
  expect(() => createThing('')).toThrow('name_required');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/exact/path/to/file.test.ts`
Expected: FAIL with "createThing is not defined"

- [ ] **Step 3: Write the minimal implementation**

```typescript
export function createThing(name: string): Thing {
  if (name === '') throw new Error('name_required');
  return { name };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/exact/path/to/file.test.ts`
Expected: PASS
````

## No Placeholders

Every step contains the actual content the implementer needs. These are plan failures:

- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling", "add validation", "handle edge cases"
- "Write tests for the above" without the test code
- "Similar to Task N" (repeat the code; tasks are read out of order)
- Steps that say what to do without showing how
- Types, functions or methods not defined in any task

## Self-Review

After writing the plan, check it against the agreed design yourself:

1. **Coverage:** can you point to a task for every requirement? Add a task for any gap.
2. **Placeholders:** search for the patterns above and fix them.
3. **Type consistency:** do names and signatures in later tasks match earlier ones? `clearLayers()` in Task 3 and `clearFullLayers()` in Task 7 is a bug.
4. **Review Focus:** does every line there have its test in the owning task?
5. **Verification:** does the header list the verification commands from your prompt, and does every task say which tests prove it?

Fix issues inline and move on.

## Submit the Plan

Call `onionsoup_submit_plan` with:

- `title`: a short name for the work
- `goal`: the one-sentence goal
- `plan`: the whole plan as markdown
- `repository`: when you own more than one repository
- `item`: only when resubmitting a revision of a plan the person rejected

Then tell the person in one or two lines what the plan does and that it is waiting for their approval. Stop. Do not start editing the desk.

- **Approved:** the runtime starts a new execution session whose first message is this plan. The work happens there, not in this chat.
- **Rejected:** the rejection carries the person's feedback. Revise the plan, record any decision they made with `onionsoup_record_decision`, and resubmit with the same `item`.
- **Delegated work:** approval comes from the surface inbox or a manager's standing grant instead of the chat. The flow is otherwise the same.

## Red Flags

| Thought | Reality |
|---------|---------|
| "The person agreed in chat, so the plan is approved" | Agreement in chat permits writing the plan. Only the recorded approval permits execution. |
| "I'll start Task 1 while they review" | Execution happens in the execution session after approval. Stop after submitting. |
| "I'll save the plan in docs/ too" | The submitted plan is the record. Add files only if the repository's conventions ask for them. |
| "The implementer can look it up in my notebook" | Subagents cannot see your notebook. Put the facts in the plan. |
| "I'll add a commit step" | Host code commits. Changes accumulate on the desk. |
