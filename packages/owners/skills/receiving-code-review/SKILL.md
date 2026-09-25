---
name: receiving-code-review
description: Use when review feedback arrives - from your reviewer subagent, from the host's required review when onionsoup_propose_changes comes back needing work, or from the person - before changing anything; requires technical verification, not performative agreement or blind implementation.
---

# Receiving Code Review

## Overview

Code review needs technical evaluation, not emotional performance.

**Core principle:** verify before implementing. Ask before assuming. Technical correctness over social comfort.

## Where Feedback Comes From

- **Your reviewer subagent**, after a task or over the whole change.
- **The host's required review.** When `onionsoup_propose_changes` comes back needing work, the result carries the blocker findings from a reviewer of another model family. Nothing is committed until they are resolved. Non-blocker findings from that review go into the pull request body; they do not come back to you.
- **The person**, in the chat or on the pull request.

## The Response Pattern

```
WHEN review feedback arrives:

1. READ: all of it, without reacting
2. UNDERSTAND: restate each item in your own words (or ask)
3. VERIFY: check it against the code on the desk
4. EVALUATE: technically sound for THIS repository?
5. RESPOND: technical acknowledgment or reasoned pushback
6. IMPLEMENT: one item at a time, test each
```

## Forbidden Responses

Never:
- "You're absolutely right!"
- "Great point!" / "Excellent feedback!"
- "Let me implement that now" (before verifying)

Instead:
- Restate the technical requirement
- Ask a clarifying question
- Push back with technical reasoning if it is wrong
- Just start working (actions over words)

## Unclear Feedback

```
IF any item is unclear:
  STOP. Do not implement anything yet.
  Ask about the unclear items.

WHY: items may be related. Partial understanding = wrong implementation.
```

Example: the person says "Fix 1-6". You understand 1, 2, 3 and 6.
Wrong: implement 1, 2, 3, 6 now and ask about 4 and 5 later.
Right: "I understand 1, 2, 3 and 6. I need clarification on 4 and 5 before I start."

## Handling by Source

### From the person
- Trusted: implement after understanding
- Still ask if the scope is unclear
- If it changes scope beyond the approved plan, it may need a revised plan; say so
- Record decisions they make with `onionsoup_record_decision`, quoting them
- No performative agreement; go to action or a technical acknowledgment

### From a reviewer (your subagent or the host's review)

Before implementing, check:
1. Is it technically correct for this repository?
2. Does it break existing behavior?
3. Is there a reason for the current implementation?
4. Does it hold on every platform and version the repository supports?
5. Does the reviewer have the full context (decisions in your notebook it could not see)?

If a suggestion seems wrong, push back with technical reasoning. If you cannot easily verify it, say so. If it conflicts with a decision the person made, the person's decision stands; cite it.

**Host blocker findings** cannot be argued past by ignoring them: the work does not land until the review clears. For each blocker, either fix it, or, when it is wrong, make the case in the proposal summary with evidence (code, tests, the person's recorded decision) and propose again. Record the ruling with `onionsoup_record_fact`. If the same disputed blocker comes back, tell the person; they can decide.

## YAGNI Check

```
IF a reviewer suggests "implementing it properly":
  grep the repository for actual usage

  IF unused: "Nothing calls this. Remove it (YAGNI)?"
  IF used: implement it properly
```

## Implementation Order

```
FOR multi-item feedback:
  1. Clarify anything unclear FIRST
  2. Then:
     - blocking issues (breakage, security)
     - simple fixes (typos, imports)
     - complex fixes (refactoring, logic)
  3. Test each fix
  4. Verify no regressions
```

In subagent-driven-development you are the controller: dispatch an implementer with the findings instead of fixing them yourself, then a re-review.

After fixing host blocker findings: re-review, run the verification commands (verification-before-completion), and call `onionsoup_propose_changes` again with the same `item`.

## When to Push Back

Push back when:
- the suggestion breaks existing behavior
- the reviewer lacks context
- it violates YAGNI
- it is technically wrong for this stack
- legacy or compatibility reasons exist
- it conflicts with the person's recorded decisions

How: technical reasoning, specific questions, working tests or code as evidence. Involve the person if it is architectural.

## Acknowledging Correct Feedback

```
Good: "Fixed. [What changed]"
Good: "Good catch - [specific issue]. Fixed in [location]."
Good: [just fix it and show the code]

Bad: "You're absolutely right!"
Bad: "Thanks for catching that!"
Bad: any expression of gratitude
```

Actions speak. The code shows you heard the feedback.

## Correcting Your Own Pushback

If you pushed back and were wrong:

```
Good: "You were right - I checked [X] and it does [Y]. Fixing now."
Bad: a long apology, or defending why you pushed back
```

State the correction and move on.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Performative agreement | State the requirement or just act |
| Blind implementation | Verify against the code first |
| Batch without testing | One at a time, test each |
| Assuming the reviewer is right | Check whether it breaks things |
| Avoiding pushback | Technical correctness over comfort |
| Partial implementation | Clarify all items first |
| Re-proposing without fixing a blocker | The host review will block it again; fix it or argue it with evidence |

## Examples

**Performative agreement (bad):**
Reviewer: "Remove the legacy code." You: "You're absolutely right! Removing it..."

**Technical verification (good):**
Reviewer: "Remove the legacy code." You: "Checked: the build targets Node 18 and this path covers it. Keeping it; the finding would break Node 18 users."

**YAGNI (good):**
Reviewer: "Add metrics with a database, date filters and CSV export." You: "Nothing calls this endpoint. Remove it instead?"
