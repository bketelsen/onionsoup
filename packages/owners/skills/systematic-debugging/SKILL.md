---
name: systematic-debugging
description: Use when you meet any bug, test failure, failed host verification, or unexpected behavior in your repository, before proposing a fix - finds the root cause first, then fixes it with a failing test.
---

# Systematic Debugging

## Overview

**Core principle:** always find the root cause before attempting a fix. Symptom fixes are failure.

**Violating the letter of this process is violating the spirit of debugging.**

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you have not completed Phase 1, you cannot propose fixes.

## When to Use

Any technical issue:
- Test failures
- Host verification failing after `onionsoup_propose_changes`
- Bugs the person or another owner reports
- Unexpected behavior
- Performance problems
- Build failures
- Integration issues

**Especially when:**
- Under time pressure (emergencies make guessing tempting)
- "Just one quick fix" seems obvious
- You have already tried several fixes
- The previous fix did not work
- You do not fully understand the issue

**Do not skip when:**
- The issue seems simple (simple bugs have root causes too)
- You are in a hurry (rushing guarantees rework)
- Someone wants it fixed now (systematic is faster than thrashing)

## The Four Phases

Complete each phase before the next.

### Phase 1: Root Cause Investigation

**Before attempting any fix:**

1. **Read error messages carefully**
   - Do not skip past errors or warnings; they often contain the answer
   - Read stack traces completely
   - Note line numbers, file paths, error codes

2. **Reproduce consistently**
   - Can you trigger it reliably? What are the exact steps?
   - Does it happen every time?
   - If not reproducible, gather more data; do not guess
   - If it only fails in host verification, run the same verification command from your prompt on the desk

3. **Check recent changes**
   - What changed that could cause this? `git diff`, `git log` on the desk
   - New dependencies, config changes, environment differences
   - Your notebook (`onionsoup_notebook`) may hold facts about earlier incidents

4. **Gather evidence in multi-component systems**

   When the system has several components (CI → build → signing, API → service → database), add diagnostic instrumentation before proposing fixes:

   ```
   For EACH component boundary:
     - Log what data enters the component
     - Log what data exits the component
     - Verify environment and config propagation
     - Check state at each layer

   Run once to gather evidence showing WHERE it breaks
   THEN analyze the evidence to find the failing component
   THEN investigate that component
   ```

   Example (multi-layer system):
   ```bash
   # Layer 1: Workflow
   echo "=== Secrets available in workflow: ==="
   echo "IDENTITY: ${IDENTITY:+SET}${IDENTITY:-UNSET}"

   # Layer 2: Build script
   echo "=== Env vars in build script: ==="
   env | grep IDENTITY || echo "IDENTITY not in environment"

   # Layer 3: Signing script
   echo "=== Keychain state: ==="
   security list-keychains
   security find-identity -v

   # Layer 4: Actual signing
   codesign --sign "$IDENTITY" --verbose=4 "$APP"
   ```

   This shows which layer fails (secrets → workflow works, workflow → build fails). Never print credential values; print whether they are set.

5. **Trace data flow**

   When the error is deep in a call stack, see [root-cause-tracing.md](root-cause-tracing.md) for the backward tracing technique.

   Quick version:
   - Where does the bad value originate?
   - What called this with the bad value?
   - Keep tracing up until you find the source
   - Fix at the source, not at the symptom

### Phase 2: Pattern Analysis

1. **Find working examples:** similar working code in the same repository
2. **Compare against references:** if implementing a pattern, read the reference implementation completely; do not skim
3. **Identify differences:** list every difference between working and broken, however small; do not assume "that can't matter"
4. **Understand dependencies:** what other components, settings, config and environment does it need? What does it assume?

### Phase 3: Hypothesis and Testing

1. **Form a single hypothesis:** "I think X is the root cause because Y". Write it down. Be specific.
2. **Test minimally:** the smallest possible change, one variable at a time.
3. **Verify before continuing:** worked → Phase 4. Did not work → form a new hypothesis. Do not stack fixes.
4. **When you do not know:** say "I don't understand X". Do not pretend. Research more, or ask an owner who knows with `onionsoup_ask`.

Record a confirmed root cause with `onionsoup_record_fact`, quoting the evidence, so the next session does not rediscover it.

### Phase 4: Implementation

1. **Create a failing test case**
   - Simplest possible reproduction, automated if possible
   - Must exist before the fix
   - Use test-driven-development

2. **Implement a single fix**
   - Address the root cause
   - One change at a time
   - No "while I'm here" improvements, no bundled refactoring

3. **Verify the fix**
   - The test passes? No other tests broken? The issue actually resolved?
   - Use verification-before-completion before claiming success

4. **If the fix does not work**
   - Stop. Count the fixes you have tried.
   - Fewer than 3: return to Phase 1 with the new information.
   - **3 or more: stop and question the architecture (step 5).** Do not attempt fix number 4 first.

5. **If 3+ fixes failed: question the architecture**

   Signs of an architectural problem:
   - Each fix reveals new shared state, coupling or problems elsewhere
   - Fixes need massive refactoring
   - Each fix creates new symptoms elsewhere

   Question fundamentals: is this pattern sound? Are we sticking with it through inertia? Should the architecture change instead?

   This is not a failed hypothesis; it is a wrong architecture. Tell the person what you found before attempting more fixes. A redesign is a scope change: it goes through brainstorming and a plan, not another patch.

## Red Flags: Stop and Follow the Process

If you catch yourself thinking:
- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "Add multiple changes, run tests"
- "Skip the test, I'll manually verify"
- "It's probably X, let me fix that"
- "I don't fully understand, but this might work"
- "The pattern says X, but I'll adapt it differently"
- "Here are the main problems: [fixes without investigation]"
- Proposing solutions before tracing data flow
- "One more fix attempt" after two or more
- Each fix reveals a new problem somewhere else

All of these mean: stop and return to Phase 1. After 3+ failed fixes, question the architecture.

## Signals From the Person That You Are Doing It Wrong

- "Is that not happening?": you assumed without verifying
- "Will it show us...?": you should have gathered evidence
- "Stop guessing": you are proposing fixes without understanding
- "Think harder about this": question fundamentals, not symptoms
- "We're stuck?": your approach is not working

When you see these, stop and return to Phase 1.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "The issue is simple, no process needed" | Simple issues have root causes too. The process is fast for simple bugs. |
| "Emergency, no time for process" | Systematic debugging is faster than guess-and-check thrashing. |
| "Just try this first, then investigate" | The first fix sets the pattern. Do it right from the start. |
| "I'll write the test after confirming the fix" | Untested fixes do not stick. The test first proves it. |
| "Several fixes at once saves time" | You cannot tell what worked, and it causes new bugs. |
| "The reference is too long, I'll adapt the pattern" | Partial understanding guarantees bugs. Read it all. |
| "I see the problem, let me fix it" | Seeing symptoms is not understanding the root cause. |
| "One more fix attempt" (after 2+ failures) | 3+ failures means an architectural problem. |
| "Host verification is flaky, propose again" | A failure is evidence. Reproduce it with the same command first. |

## Quick Reference

| Phase | Key activities | Success criteria |
|-------|---------------|------------------|
| 1. Root cause | Read errors, reproduce, check changes, gather evidence | Understand what and why |
| 2. Pattern | Find working examples, compare | Differences identified |
| 3. Hypothesis | Form a theory, test minimally | Confirmed, or a new hypothesis |
| 4. Implementation | Create a test, fix, verify | Bug resolved, tests pass |

## When the Process Finds No Root Cause

If investigation shows the issue is truly environmental, timing-dependent or external:

1. You have completed the process
2. Record what you investigated with `onionsoup_record_fact`
3. Implement appropriate handling (retry, timeout, an error with a specific reason)
4. Add logging for future investigation

But 95% of "no root cause" cases are incomplete investigation.

## Supporting Techniques

- [root-cause-tracing.md](root-cause-tracing.md): trace bugs backward through the call stack to the original trigger
- [defense-in-depth.md](defense-in-depth.md): add validation at several layers after finding the root cause
- [condition-based-waiting.md](condition-based-waiting.md): replace arbitrary timeouts with condition polling
