---
name: verification-before-completion
description: Use when about to claim work is complete, fixed or passing, before marking a task done, and before every onionsoup_propose_changes - run the verification commands from your prompt and read the output; evidence before claims, always.
---

# Verification Before Completion

## Overview

**Core principle:** evidence before claims, always.

**Violating the letter of this rule is violating the spirit of this rule.**

Host code re-verifies the desk in a sandbox after `onionsoup_propose_changes`, and a reviewer from another model family reviews the diff. That is not a reason to skip your own run. A red desk wastes a sandbox run and a review, comes back as needs-work, and shows the person you claimed something you had not checked.

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you have not run the verification command in this message, you cannot claim it passes.

## The Gate Function

```
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: which command proves this claim?
   (For "done" or a proposal: the verification commands listed in your prompt.)
2. RUN: the FULL command, fresh and complete, in the desk
3. READ: the full output; check the exit code; count failures
4. VERIFY: does the output confirm the claim?
   - If NO: state the actual status with evidence
   - If YES: state the claim WITH evidence
5. ONLY THEN: make the claim

Skip any step = lying, not verifying
```

## Common Failures

| Claim | Requires | Not sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | A previous run, "should pass" |
| Linter clean | Linter output: 0 errors | A partial check, extrapolation |
| Build succeeds | Build command: exit 0 | Linter passing, logs look fine |
| Bug fixed | The original symptom's test passes | Code changed, assumed fixed |
| Regression test works | Red-green cycle verified | The test passes once |
| Subagent completed | `git diff` on the desk shows the changes | The subagent reports success |
| Requirements met | Line-by-line check against the plan | Tests passing |
| Ready to propose | Every verification command from your prompt green | One package's tests green |

## Red Flags: Stop

- Using "should", "probably", "seems to"
- Expressing satisfaction before verifying ("Great!", "Done!")
- About to call `onionsoup_propose_changes` without running the verification commands
- Trusting a subagent's success report
- Relying on partial verification
- "Host code will catch it anyway"
- Thinking "just this once"
- Any wording that implies success without having run verification

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Should work now" | Run the verification. |
| "I'm confident" | Confidence is not evidence. |
| "Just this once" | No exceptions. |
| "Linter passed" | The linter is not the compiler. |
| "The implementer said success" | Verify independently. |
| "Host verification runs anyway" | Proposing a red desk wastes a run and a review. |
| "A partial check is enough" | Partial proves nothing. |
| "Different words, so the rule doesn't apply" | Spirit over letter. |

## Key Patterns

**Tests:**
```
Good: [run the test command] [see: 34/34 pass] "All tests pass"
Bad: "Should pass now" / "Looks correct"
```

**Regression tests (TDD red-green):**
```
Good: write → run (pass) → revert the fix → run (MUST FAIL) → restore → run (pass)
Bad: "I've written a regression test" (without red-green verification)
```

**Build:**
```
Good: [run the build] [see: exit 0] "Build passes"
Bad: "Linter passed" (the linter does not check compilation)
```

**Requirements:**
```
Good: re-read the plan → checklist → verify each → report gaps or completion
Bad: "Tests pass, done"
```

**Subagent delegation:**
```
Good: subagent reports success → check the desk diff → verify the changes → report the actual state
Bad: trust the report
```

**Proposing:**
```
Good: run every verification command from your prompt → all green → onionsoup_propose_changes with a summary that states what was run and the result
Bad: onionsoup_propose_changes "should be fine, host verifies"
```

## When to Apply

Always before:
- any claim of success or completion, in any wording
- any expression of satisfaction
- marking a task complete or recording it in your notebook
- moving to the next task
- `onionsoup_propose_changes`
- telling the person or another owner something works

The rule covers exact phrases, paraphrases, synonyms and implications of success.
