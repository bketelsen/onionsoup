# Scoped Re-Review Prompt Template

Use this template after a fix round. The re-reviewer verifies each finding was addressed and checks the fix for new breakage. It is not a fresh review; the full review already happened.

```
task:
  subagent_type: "[your reviewer's name from your prompt, onionsoup-reviewer-<owner-id>]"
  description: "Re-review Task N fix round R"
  prompt: |
    You are re-reviewing one task's fix round. A previous review produced
    findings; an implementer has tried to fix them. Verdict each finding
    and inspect the fix, nothing else.

    ## The Task

    [The task's full text from the plan, verbatim]

    ## Findings Under Verification

    [The Critical/Important findings and spec gaps from the previous review,
    verbatim, one per bullet]

    ## The Fix

    The implementer's fix report:
    [fix report, verbatim]

    Work in: [desk path]
    Files the fix touched: [list]

    Read the current state of those files and `git diff -- <files>`. Your
    review is read-only: do not edit, stage, commit, or move HEAD.

    ## You Do Not Dispatch Subagents

    Do all of this review yourself.

    ## Scope

    Verdict every finding. Inspect what the fix changed for new problems it
    introduced. Do not re-review code the fix did not touch; report issues
    outside the fix under Out-of-Scope Observations. They do not block this
    task.

    ## Tests

    Treat the fix report as unverified claims: confirm it names the covering
    tests and shows their output, and check the claims against the code. Do
    not re-run the suite. Run a focused test only when the code raises a
    specific doubt no existing run answers.

    ## Output Format

    Start directly with the first verdict. No preamble.

    ### Finding Verdicts
    For each finding, in order:
    - **[finding one-liner]**: ADDRESSED | NOT ADDRESSED, with file:line
      evidence. "Attempted" is not addressed; the defect must be gone.

    ### New Breakage in the Fix
    Anything the fix broke or introduced, with severity and file:line.
    "None" if clean.

    ### Out-of-Scope Observations
    Issues outside the fix. Non-blocking. "None" if none.

    ### Verdict
    **Fix round:** All findings addressed, no new Critical/Important
    breakage | Findings remain open: [list]
```

**Re-reviewer returns:** per-finding verdicts, new breakage in the fix, out-of-scope observations, and a round verdict. The controller records out-of-scope observations as deferred minors with `onionsoup_record_fact`.
