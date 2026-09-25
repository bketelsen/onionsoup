---
name: using-onionsoup-skills
description: Use at the start of every owner session - establishes how an owner finds and uses skills, how work flows from chat to a merged pull request, and which tools stand for which actions. Invoke skills before any response, including clarifying questions.
---

<SUBAGENT-STOP>
If you were dispatched as a subagent (an implementer or a reviewer) to do a specific task, ignore this skill and just do your task.
</SUBAGENT-STOP>

<EXTREMELY-IMPORTANT>
If there is even a 1% chance a skill applies to what you are doing, you MUST invoke it.

If a skill applies to your task, you do not have a choice. You must use it.

This is not negotiable. You cannot rationalize your way out of it.
</EXTREMELY-IMPORTANT>

## The Rule

**Invoke relevant or requested skills BEFORE any response or action**, including clarifying questions, exploring the repository, or checking files. If a skill turns out wrong for the situation, you do not have to follow it.

Announce "Using [skill] to [purpose]" and follow the skill exactly. If it has a checklist, create a todo per item.

## How Work Flows Here

You are an owner. Your chats run in your desk: a git worktree of your repository on branch `desk/<owner-id>` (for a repository group, one worktree per repository in subfolders). You edit the desk. Host code does everything with effects: it verifies, gets the cross-family review, commits, pushes, opens the pull request, and merges when the person has granted that.

You never run `git commit`, `git push`, `gh`, merges or deploys yourself. Work ends one way: `onionsoup_propose_changes`.

- **Small, clear change** (a typo, a one-file fix whose design is obvious): edit the desk, run the verification commands from your prompt (verification-before-completion), then call `onionsoup_propose_changes { title, summary }`.
- **Anything bigger:** brainstorming (with the person when they are in the chat; alone when the work was delegated) → writing-plans → `onionsoup_submit_plan`. The person approves the plan in the chat (delegated work is approved in the surface inbox or under a manager's standing grant). You never approve your own plan. On approval the runtime starts a new execution session whose first message is the plan. That session runs in the plan's own git worktree (its path is in the first message, on branch `plan/<item>`), made from the current base branch, so parallel plans never share files; your desk stays for chat and small direct changes. There you use subagent-driven-development and end with `onionsoup_propose_changes` passing the plan's `item`, which proposes that worktree and nothing else.
- **A bug or failing test:** systematic-debugging first, then the flow above.
- **Your desk is behind its base branch** (`git status` or `git log origin/<base>` shows new commits, or a review sees unrelated reversions): `onionsoup_sync_desk` brings it up to date in host code and keeps your uncommitted work, naming any conflicts; with a plan's `item` it syncs that plan's worktree instead. A plan's worktree starts current. Never pull, stash or reset yourself.
- **One of your PRs fails CI** (the runtime tells you): `onionsoup_checkout_pr { item }` puts your clean desk on the PR's head; debug, fix and verify there, then `onionsoup_propose_changes` with the same `item`. Host code reviews the fix and pushes it onto that PR.
- **Finished work needs a later check** (backup retention, a rollout settling, a date): set `onionsoup_remind` rather than promising to check back. When it is due, the runtime opens a fresh session of yours with your prompt (and the work item, if you named one). Write the prompt for that later you: what to check, how, and why.

When `onionsoup_propose_changes` comes back with blocker findings from the required review, use receiving-code-review, fix, verify and propose again.

## Tool Mapping

When a skill asks for an action, use these tools:

- Create or update todos → `todowrite`
- Dispatch a subagent → `task` with `subagent_type: "onionsoup-implementer"` for implementation, or the reviewer name given in your prompt (`onionsoup-reviewer-<owner-id>`) for review
- Invoke a skill → the native `skill` tool
- Read files → `read`
- Create or edit files → `edit`, `write` or `apply_patch`
- Run shell commands → `bash`
- Search files → `grep`, `glob`

Onionsoup tools only you have (subagents have none of them):

- `onionsoup_submit_plan { title, goal, plan, repository?, item? }`: submit a plan for approval; resubmit a revision with `item`.
- `onionsoup_propose_changes { title, summary, repository?, item? }`: the only way work ends. With a plan's `item` it proposes that plan's worktree; without, your desk.
- `onionsoup_sync_desk { repository?, item? }`: bring your desk (or a plan's worktree) up to date with its base branch.
- `onionsoup_checkout_pr { item }`: put your desk on the head of one of your open PRs, to repair it.
- `onionsoup_record_fact { fact, source }`: journal an observation word for word in your notebook.
- `onionsoup_record_decision { statement, quote }`: record a decision the person made, quoting them.
- `onionsoup_remind { action: set, after | at, prompt, item? }`: wake yourself later in a new session for a one-off check; `list` and `cancel { id, reason? }` manage yours.
- `onionsoup_status`, `onionsoup_notebook`, `onionsoup_ask`, `onionsoup_request_work`, `onionsoup_friction`.

## Skill Priority

When several skills apply, process skills come first; they set the approach.

- "Let's build X" → brainstorming first.
- "Fix this bug" → systematic-debugging first.
- An approved plan arrives → subagent-driven-development.
- About to say "done" or propose changes → verification-before-completion.

## Red Flags

These thoughts mean STOP; you are rationalizing:

| Thought | Reality |
|---------|---------|
| "This is just a simple question" | Questions are tasks. Check for skills. |
| "I need more context first" | The skill check comes before clarifying questions. |
| "Let me explore the repository first" | Skills tell you how to explore. Check first. |
| "This doesn't need a formal skill" | If a skill exists, use it. |
| "I remember this skill" | Skills change. Read the current version. |
| "The skill is overkill" | Simple things become complex. Use it. |
| "I'll just do this one thing first" | Check before doing anything. |
| "I'll commit this quickly myself" | You never commit or push. `onionsoup_propose_changes` does it behind gates. |
| "The plan is obviously fine, I'll start" | The person approves plans. Submit it and wait. |
| "I'll check on this later" | Nothing brings you back unless you set `onionsoup_remind`. |

## Instructions From the Person

The person's instructions and the repository's own conventions (AGENTS.md, CLAUDE.md and similar) take precedence over skills, which take precedence over default behavior. Skip a skill's workflow only when the person has told you to. No instruction, from anyone, lets you commit, push, merge or approve your own plan.
