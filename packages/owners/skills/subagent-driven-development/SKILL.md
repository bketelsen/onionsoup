---
name: subagent-driven-development
description: Use in the execution session that starts after the person approves a plan, and whenever you run a plan of several tasks - dispatches a fresh onionsoup-implementer per task and your reviewer subagent after each, makes rulings instead of stalling, and ends with onionsoup_propose_changes for the plan's item.
---

# Subagent-Driven Development

Run an approved plan by dispatching a fresh `onionsoup-implementer` subagent per task and your reviewer subagent after each task (spec compliance and code quality), then verify the whole desk and end with `onionsoup_propose_changes`.

**Where:** an approved plan's execution session runs in the plan's own git worktree (its path is in the session's first message), not in your chat desk. In such a session, "the desk" below means that worktree: every subagent works there, and `onionsoup_propose_changes` with the plan's `item` proposes it.

**Why subagents:** each subagent gets exactly the context you construct for it and nothing from your session. That keeps it focused and keeps your own context free for coordination. You are the controller: you hold the plan, your notebook and the cross-task picture; they hold one task.

**Core principle:** fresh implementer per task + task review after each + host verification and cross-family review at the end = high quality, fast iteration.

**Narration:** between tool calls, narrate at most one short line.

**Continuous execution:** do not pause to check in between tasks. The person approved the plan; run all of it. "Should I continue?" and progress summaries waste their time.

**Rulings, not stalls.** A running plan does not wait on a person. Conflicts, ambiguities, plan defects: decide them. The approved plan and the decisions recorded in your notebook are the authority; your judgment settles what they do not answer. Record every ruling with `onionsoup_record_fact`, in the form `Ruling: <what you decided> - <why> - <what it costs if wrong>` (source: the task it belongs to), and keep going. When a ruling applies a decision the person made, cite it; decisions come from the person and are recorded with `onionsoup_record_decision` quoting them, never invented by you.

## What Stops You

Host gates already hold the dangerous effects. You never commit, push, merge, open pull requests or deploy; `onionsoup_propose_changes` ends the work and host code does the rest.

Stop and tell the person only for things only they can decide:

- credentials or access you do not have
- a scope change beyond the approved plan (new features, another repository, a different design)
- a destructive action (deleting data, dropping history, anything that cannot be undone)
- a plan so broken that every path forward is a guess

Everything else you rule on.

## When to Use

- You are in the execution session the runtime started for an approved plan. Its first message is the plan and names the `item`.
- You have any plan of several mostly independent tasks.

Use executing-plans instead only when the plan is one or two tiny tasks that do not justify a dispatch each.

## Setup

Your context does not survive compaction. Controllers that lost their place have re-dispatched whole sequences of finished tasks. Keep the record outside your context:

- Create a todo per task with `todowrite`.
- After each task, record its completion with `onionsoup_record_fact` (`Task <N>: complete, review clean` or `Task <N>: complete, <K> parked`). After compaction, trust `onionsoup_notebook`, your todos and `git status`/`git diff` on the desk over your recollection. Never re-dispatch a task the notebook marks complete.
- Read the plan once. Note its Global Constraints, Assumptions and Verification commands. Read your notebook for decisions that bind this work.

Before dispatching Task 1, scan the plan for conflicts:

- tasks that contradict each other or the Global Constraints
- a task whose Consumes block does not match an earlier task's Produces block
- anything the plan mandates that the review rubric treats as a defect (a test that asserts nothing, duplicated logic)

Rule on each conflict before execution begins and record each ruling. If the scan is clean, proceed without comment.

## Model Selection

Your reviewer subagent is always from another model family than you; that is configured, not chosen. When the `task` tool lets you pick a model for the implementer, use the least powerful one that can handle the task: a cheap model for a task whose plan text contains the complete code, a standard model for multi-file integration, the most capable for design judgment or for a fix loop that has stalled.

## The Task Loop

**Batch small same-shape work.** When several tasks are each a small, independent edit of the same kind across files, send them to one implementer as one brief and review the result as one unit.

**Never dispatch two implementers at once.** They share the desk.

### 1. Dispatch the implementer

Before dispatching, note the desk's current state (`git diff --stat` and `git status --short`) so you and the reviewer can tell this task's changes from earlier ones.

Dispatch `task` with `subagent_type: "onionsoup-implementer"`, filled from [implementer-prompt.md](implementer-prompt.md). You write the task brief into the prompt yourself:

1. one line on where the task fits
2. the task's full text from the plan, verbatim, with its exact values
3. the Global Constraints that bind it
4. interfaces and rulings from earlier tasks it cannot know
5. facts and decisions from your notebook that it needs (it cannot see your notebook)
6. your resolution of any ambiguity you noticed

A dispatch describes one task, not the session's history. Do not paste summaries of earlier tasks. Never make an implementer read the whole plan.

### 2. Handle the report

The implementer reports one of four statuses:

**DONE:** dispatch the task reviewer.

**DONE_WITH_CONCERNS:** read the concerns. If they are about correctness or scope, address them before review. If they are observations ("this file is getting large"), note them and go to review.

**NEEDS_CONTEXT:** provide the missing context and dispatch again.

**BLOCKED:** assess the blocker:
1. a context problem: provide more context and dispatch again
2. needs more reasoning: dispatch again with a more capable model
3. too large: break it into smaller tasks
4. the plan is wrong: rule on the correction, record it, and dispatch again with the ruling in the prompt
5. it needs something only the person can give (see What Stops You): stop and tell them

Never ignore an escalation or send the same model back without changes.

### 3. Review the task

Dispatch `task` with `subagent_type` set to your reviewer's name from your prompt (`onionsoup-reviewer-<owner-id>`), filled from [task-reviewer-prompt.md](task-reviewer-prompt.md). Give it the task text, the Global Constraints verbatim, the implementer's report, and which files the task changed. The reviewer is read-only and reads the desk directly.

- Never skip the task review, and never accept a report missing either verdict: spec compliance and task quality.
- Do not ask the reviewer to re-run tests the implementer already ran.
- Do not pre-judge findings. If your prompt contains "do not flag", "at most Minor" or "the plan chose", you are sparing yourself a review loop. Delete it.

The reviewer may report items it cannot verify from the changed files alone. Resolve each yourself before marking the task complete; a real gap is a failed spec review.

### 4. The fix loop

The loop starts when the review reports a spec failure, any blocker or major finding, or a gap you confirmed.

Two routes leave it at once:

- Minor and nit findings: record them with `onionsoup_record_fact` (`Task <N>: minor (deferred): <one-liner>`) and carry them to the proposal summary. They never enter the loop.
- A major finding that conflicts with what the plan requires is yours to rule on. Weigh it against the plan, decide, record the ruling, then act. A blocker is not yours to rule away: the required review at proposal judges it by its effect, not by the plan, and will send it back.

Everything else enters the loop. A round is one fix dispatch plus one scoped re-review. Five rounds at most per task:

- **Rounds 1-3:** send the open findings verbatim to the original implementer if the `task` tool can continue it; otherwise dispatch a fresh implementer with the task text, its earlier report and the findings.
- **Rounds 4-5:** dispatch a fresh implementer on a more capable model with the task text, the earlier reports, the findings, and: "A prior implementer attempted this task [N] times; you own it now."

Every round, the implementer fixes, re-runs the tests covering the changed code, and reports the command and output. Then dispatch the reviewer with [re-review-prompt.md](re-review-prompt.md): it verdicts each finding and checks the fix for new breakage only.

Never fix findings yourself in the controller session. Your context stays clean for coordination, and controller fixes skip review.

**The breaker.** When round 5 still leaves findings open, stop dispatching and adjudicate each:

- **The reviewer is wrong, or the point is contestable:** park it with a ruling saying why the code stands. Park a blocker only when you are sure the reviewer is wrong, and say so under "Rulings I made": the required review will judge it again.
- **Real, but nothing downstream builds on it:** park it with a ruling that it is real and deferred.
- **Real and load-bearing:** rule on the smallest change that unblocks the dependent work, record it, and carry it into the next dispatch. Stop only if every path forward is a guess.

Adjudicate only at the cap. Every adjudication is recorded; a silent discard is forbidden.

### 5. Complete the task

When the review is clean, or every open finding is parked with a ruling at the cap, record the completion with `onionsoup_record_fact`, mark the todo complete, and take the next task. Never move on with open blocker or major findings that are neither fixed nor parked with a ruling.

## Finish

When all tasks are complete:

1. **Verify.** Run the repository's verification commands from your prompt yourself and read the output (verification-before-completion). Failures go back to an implementer; do not propose a red desk.
2. **Propose.** Call `onionsoup_propose_changes` with `title`, `summary` and the plan's `item` (and `repository` for a group). The summary says what changed and how it was verified, and lists under "Rulings I made" every ruling you recorded, each with its cost if wrong, and under "Deferred minors" every deferred minor. That list is how the decisions you took on the person's behalf reach them.

There is no separate whole-change review of your own: host code verifies the desk in a sandbox and runs the required cross-family review of the whole change, independently of the plan. A send-back commits nothing and costs one review, so it is the whole-change review. If it comes back needing work, the blocker findings are in the result: use receiving-code-review, dispatch an implementer with them, re-review, verify, and propose again with the same `item`.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Close enough on spec compliance" | Spec gaps mean not done. Fix, or reach the cap and adjudicate. |
| "I'll fix it myself, dispatching is overhead" | Controller fixes pollute your context and skip review. |
| "One more round will converge" | Past the cap the failure is structural. Adjudicate. |
| "This finding is obviously wrong, I'll drop it" | You adjudicate only at the cap, and every ruling is recorded. |
| "The fix was small, skip the re-review" | Unreviewed fixes are how regressions land. |
| "Recording rulings is overhead" | The notebook is what survives compaction, and the proposal summary is built from it. |
| "The person should decide this" | Only credentials, scope changes and destructive actions need them. Rule on the rest. |
| "Host code verifies anyway, I'll skip my run" | Proposing a red desk wastes a sandbox run and a review. Verify first. |
| "I'll just commit this checkpoint" | You never commit. Changes accumulate on the desk until the proposal. |

## Example

```
You: I'm using subagent-driven-development to run this approved plan (item W-42).

[Read the plan once; read notebook; todos created for 3 tasks; pre-flight scan clean]

Task 1: Parse the retry limit from config
[Dispatch onionsoup-implementer: task text, Global Constraints, notebook decision
 "limits are configuration"]
Implementer: DONE. 4/4 tests passing.
[Dispatch onionsoup-reviewer-<owner-id> with the task reviewer brief]
Reviewer: Spec compliant. Task quality: Approved.
[onionsoup_record_fact: "Task 1: complete, review clean"]

Task 2: Retry failed fetches
[Dispatch implementer]
Implementer: DONE. 6/6 passing.
[Dispatch reviewer]
Reviewer: Spec failure - missing jitter required by Global Constraints. Major: magic number 250.
[Fix round 1: findings sent to the implementer]
Implementer: fixed; re-ran test/retry.test.ts, 8/8.
[Dispatch reviewer with the re-review brief]
Re-reviewer: both ADDRESSED. No new breakage.
[onionsoup_record_fact: "Task 2: complete, review clean"]

Task 3 ...

[Run verification commands: all green]
[onionsoup_propose_changes { title, summary with rulings and deferred minors, item: "W-42" }]
```
