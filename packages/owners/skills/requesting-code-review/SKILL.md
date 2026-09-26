---
name: requesting-code-review
description: Use after each task, when stuck, or before a risky refactor - dispatches your reviewer subagent (a model from another family) with precisely built context to catch issues before they cascade or reach the host's required review.
---

# Requesting Code Review

Dispatch your reviewer subagent to catch issues before they cascade. The reviewer gets context you build for it, never your session's history.

**Core principle:** review early, review often.

Two reviews exist here:

- **Your reviewer subagent** (`onionsoup-reviewer-<owner-id>`, named in your prompt): read-only, always from a different model family than you. You dispatch it during the work.
- **The host's required review:** after `onionsoup_propose_changes`, host code has a reviewer from another family review the whole diff before anything is committed. Its blocker findings come back as needs-work. You do not dispatch it and cannot skip it.

The required review is the review of the whole change: a send-back commits nothing and costs one review, so do not run a second whole-change review of your own before proposing. Your own reviews catch problems per task, when they are cheapest to fix, on the same severity scale the required review uses.

## When to Request Review

**Mandatory:**
- After each task in subagent-driven-development

**Optional but valuable:**
- When stuck (fresh perspective)
- Before refactoring (baseline check)
- After fixing a complex bug

## How to Request

1. **Know what to review.** Changes live uncommitted on the desk. Note the files involved; `git diff --stat` and `git status --short` in the desk show them. For a repository group, name the subfolder.
2. **Dispatch the reviewer:** `task` with `subagent_type` set to your reviewer's name, filled from [code-reviewer.md](code-reviewer.md). Include:
   - what was built, in a sentence or two
   - the requirements: the plan or task text, verbatim
   - the desk path and the files to review
   - facts and decisions from your notebook that bind the change (the reviewer cannot see your notebook)
3. **Act on the feedback** (receiving-code-review):
   - fix blockers at once
   - fix major issues before going on
   - record Minor issues as deferred with `onionsoup_record_fact`
   - push back with reasoning when the reviewer is wrong

You are the controller: dispatch an implementer to make fixes during subagent-driven-development; fix yourself only when you are the implementer (a small direct change or executing-plans).

## Example

```
[Task 2 done: added verifyIndex() and repairIndex()]

You: Requesting review before Task 3.

[Dispatch onionsoup-reviewer-<owner-id>]
  What was built: verifyIndex() and repairIndex() with 4 issue types
  Requirements: Task 2 text from the approved plan
  Files: src/index/verify.ts, test/index/verify.test.ts
  Binding decision: "repairs must never delete entries" (person, recorded)

Reviewer:
  Strengths: clean structure, real tests
  Major: no progress reporting for large indexes
  Minor: magic number 100 for the reporting interval
  Ready: with fixes

You: [dispatch implementer with the major finding; record the minor as deferred]
[Continue to Task 3]
```

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "I'll review the diff myself instead" | You are the coordinator. Reviewing inline burns your context, and you share the author's blind spots. |
| "The reviewer needs my whole history" | Give it built context. That keeps it on the work, not your thought process. |
| "The host reviews anyway" | The host's review blocks the proposal; finding it there costs a whole round trip. |

## Red Flags

**Never:**
- Skip review because "it's simple"
- Ignore blockers
- Go on with unfixed major issues
- Argue with valid technical feedback

**If the reviewer is wrong:**
- Push back with technical reasoning
- Show the code or tests that prove it works
- Ask for clarification
