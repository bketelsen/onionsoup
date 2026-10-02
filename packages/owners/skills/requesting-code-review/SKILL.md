---
name: requesting-code-review
description: Use when an optional task review would help, when stuck, or before a risky refactor - choose local review or dispatch your configured reviewer subagent with precise context; neither replaces the final required host review.
---

# Requesting Code Review

Review locally or optionally dispatch your reviewer subagent to catch issues before they cascade. A dispatched reviewer gets context you build for it, never your session's history.

**Core principle:** review early, review often.

Two reviews exist here:

- **Your reviewer subagent** (`onionsoup-reviewer-<owner-id>`, named in your prompt): read-only, always from a different model family than you. You dispatch it during the work.
- **The host's required review:** after `onionsoup_propose_changes`, host code has a reviewer from another family review the whole diff before anything is committed. Its blocker findings come back as needs-work. You do not dispatch it and cannot skip it.

The required review is the review of the whole change: a send-back commits nothing and costs one review, so do not run a second whole-change review of your own before proposing. Your own reviews catch problems per task, when they are cheapest to fix, on the same severity scale the required review uses.

## When to Request Review

**Optional but valuable:**
- After a task whose risks justify a fresh perspective
- When stuck (fresh perspective)
- Before refactoring (baseline check)
- After fixing a complex bug

## How to Request

1. **Know what to review.** Changes live uncommitted on the desk. Note the files involved; `git diff --stat` and `git status --short` in the desk show them. For a repository group, name the subfolder.
2. **Review locally, or dispatch the reviewer:** if delegation helps, use `task` with `subagent_type` set to your reviewer's name, filled from [code-reviewer.md](code-reviewer.md). If that agent is unavailable, continue locally. Include:
   - what was built, in a sentence or two
   - the requirements: the plan or task text, verbatim
   - the desk path and the files to review
   - facts and decisions from your notebook that bind the change (the reviewer cannot see your notebook)
3. **Act on the feedback** (receiving-code-review):
   - fix blockers at once
   - fix major issues before going on
   - record Minor issues as deferred with `onionsoup_record_fact`
   - push back with reasoning when the reviewer is wrong

Make fixes yourself or optionally dispatch an implementer, then verify the changed behavior. Optional task review never replaces the one final independent-family publication review and host verification.

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
| "Local review replaces independent review" | Local task review is useful, but host publication still requires another model family. |
| "The reviewer needs my whole history" | Give it built context. That keeps it on the work, not your thought process. |
| "The host reviews anyway" | The host's review blocks the proposal; finding it there costs a whole round trip. |

## Red Flags

**Never:**
- Skip the required host publication review because "it's simple"
- Ignore blockers
- Go on with unfixed major issues
- Argue with valid technical feedback

**If the reviewer is wrong:**
- Push back with technical reasoning
- Show the code or tests that prove it works
- Ask for clarification
