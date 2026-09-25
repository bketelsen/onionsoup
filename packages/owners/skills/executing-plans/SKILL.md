---
name: executing-plans
description: Use when a plan is one or two tiny tasks not worth a subagent dispatch each - you implement it yourself on the desk task by task with TDD, get one review from your reviewer subagent at the end, verify, and end with onionsoup_propose_changes.
---

# Executing Plans

Run the plan yourself, task by task, on the desk: no implementer per task, no reviewer per task. One review of the whole change at the end from your reviewer subagent.

**Why inline:** subagent-driven-development pays for a fresh implementer and reviewer on every task. For a tiny plan that is overhead. Inline execution keeps what those bought by other means: the task text is the spec, your notebook is your memory, TDD is the per-task gate, and the final reviewer is the second pair of eyes.

**Core principle:** the plan already did the thinking. Execute it exactly, prove each step with a test you watched fail and then pass, and leave a record that survives your own forgetting.

**When not to use it:** a plan with more than a couple of tasks, or tasks that need judgment, goes to subagent-driven-development. Inline execution over a long plan gives its last tasks the least of you.

**Continuous execution:** do not pause to check in between tasks.

**Rulings, not stalls.** Conflicts, ambiguities, plan defects: decide them, with the approved plan and the decisions in your notebook as the authority. Record each ruling with `onionsoup_record_fact` as `Ruling: <what you decided> - <why> - <what it costs if wrong>`. A deviation from the plan without a recorded ruling is a decision made in secret.

## What Stops You

You never commit, push, merge, open pull requests or deploy; `onionsoup_propose_changes` ends the work and host code does the rest. Stop and tell the person only for what only they can decide: credentials or access you lack, a scope change beyond the approved plan, a destructive action, or a plan so broken that every path forward is a guess.

## Setup

- Read the plan once. Note its Global Constraints, Assumptions and Verification commands. Read your notebook for decisions that bind the work.
- Create a todo per task with `todowrite`.
- Load test-driven-development now. It governs every step below.
- For every task that consumes what an earlier task produces, check the two agree. Rule on each conflict and record it.

## The Task Loop

Keep long output out of your context: redirect it to a file under `/tmp` and read the tail.

### 1. Take the task

Re-read the task's text in the plan, even if you remember it. You remember a summary; the plan has the exact values. Mark its todo in progress.

### 2. Work the steps

Follow the steps in order. A test step's code is written first and run first; watching it fail is a step, not a formality. A test that passes before the implementation exists is a finding about the test.

Every step that runs a command has an `Expected:` line. Run it, read the output, compare:

- **Matches:** next step.
- **The code is wrong:** use systematic-debugging. Find the cause; never patch the symptom to make the output match.
- **The plan is wrong** (a step contradicts the design, an interface does not match, a command cannot work): rule on the smallest change that satisfies the design, record the ruling, and continue.

### 3. The completion contract

Before a task is complete, all of this is true with evidence in this session:

- Every test the task names exists, ran, and you read the output.
- The final test run for the task passed.
- Every `Expected:` line was compared against real output.
- Every deviation has a recorded ruling.

verification-before-completion governs the claim. Record `Task <N>: complete, tests: <command> -> <result>` with `onionsoup_record_fact`, mark the todo complete, and take the next task.

## Final Review

Dispatch your reviewer (`task` with the reviewer name from your prompt) using [code-reviewer.md](../requesting-code-review/code-reviewer.md), with the whole desk diff, the plan, its Review Focus lines, and your rulings. Do not replace it with your own read of the diff; same author, same blind spots.

Sort the findings before acting. The severity labels are advice; the gate is yours. Re-grade by effect on a person using the software, not by whether the plan mentioned the input.

- **Critical and Important:** fix them yourself in ONE pass. Each fix is proven by TDD: a test that reproduces the finding, watched failing, then passing, then the whole suite green.
- **Minor:** record as `Final: minor (deferred): <one-liner>`. Minors never enter the fix pass.
- A finding you decide not to fix is a ruling; record it.

There is no second fix pass.

## Finish

1. Run the repository's verification commands from your prompt and read the output. Do not propose a red desk.
2. Call `onionsoup_propose_changes` with `title`, `summary` and the plan's `item` (and `repository` for a group). The summary lists every ruling under "Rulings I made", each with its cost if wrong, and every deferred minor under "Deferred minors".

If the host's required review sends it back, use receiving-code-review, fix, verify, and propose again with the same `item`.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "I remember what Task N says" | You remember a summary. Re-read the task. |
| "The plan's code is right, skip watching the test fail" | A test you never saw fail proves nothing. |
| "The plan is wrong here, I'll just do the right thing" | Do the right thing and record the ruling. |
| "I read my own diff; the final reviewer is redundant" | Same author, same blind spots. Dispatch the reviewer. |
| "Tests should pass, the change was trivial" | "Should" is not evidence. Run them. |
| "I'll fix the minors too while I'm in there" | Record them; the person decides. |
| "Let me commit what I have so far" | You never commit. The proposal does. |
