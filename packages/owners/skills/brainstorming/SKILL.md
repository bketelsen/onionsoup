---
name: brainstorming
description: Use before any creative work in your repository - new features, new behavior, changed interfaces - to agree the design with the person in chat (or, for delegated work, to settle it alone and record your assumptions) before any plan or edit.
---

# Brainstorming Ideas Into Designs

Turn an idea into a design the person recognizes as theirs, through plain dialogue in the chat. Classify how much process the request needs, understand the context, refine the idea, present a design, and get the person's approval. Architectural work then goes to writing-plans; the plan you submit with `onionsoup_submit_plan` is the record.

## Establish Shared Understanding

1. **Discover intent.** From the request and context, identify the intended outcome, who it is for, and what success looks like. When that is missing, ask one focused question about purpose before proposing features or an approach.
2. **Write back your understanding.** Summarize the outcome, constraints and success criteria in a short note. Separate what the person said from your assumptions. Invite correction and fold in the answer.
3. **Carry intent into the design.** Check every proposed feature and technical choice against that understanding.

When the request already supplies purpose and constraints, reflect it back instead of asking again.

## When There Is No Person

Delegated work (a request from another owner or a manager) arrives without anyone in the chat to answer questions. Brainstorm alone:

- Read the request, your notebook (`onionsoup_notebook`) and the repository.
- If another owner holds the answer, ask it with `onionsoup_ask`.
- Pick the simplest design that meets the request. Record each assumption you made with `onionsoup_record_fact` and list it in the plan under an "Assumptions" heading, so whoever approves the plan can correct it.
- Go on to writing-plans. The approval gate still applies; it just happens in the inbox or under a standing grant.

<HARD-GATE>
Do not edit the desk, scaffold, or install dependencies until the selected path's gate is passed:

- Spike: the person agrees to the question and probe.
- Bounded: the person says yes to the short in-chat design.
- Architectural: the person agrees the design in chat, then approves the plan you submit with `onionsoup_submit_plan`. Agreement in chat permits writing the plan; only the recorded approval permits execution.

A reply approves only the stage actually presented. Read-only exploration of the repository is allowed at any time.
</HARD-GATE>

## Three Paths

Before your first question, classify the request and say so, so the person can override: "this looks bounded, so I'll propose a short design here".

- **Spike**: a feasibility question ("can we...", "is it possible..."). The output is an answer, not code you keep. Present the question and what you will try in two or three sentences, get a nod, investigate as cheaply as correctness allows, and report a recommendation. Anything you built is throwaway; revert it from the desk before you move on.
- **Bounded**: a well-scoped change to code that already exists here: a new flag, a small endpoint, a one-file fix. Bounded means the flow you are changing is already in the repository to read. Ask the questions that matter, present a short design in chat, and STOP until the person says yes. Then edit the desk (test-driven-development applies), verify, and end with `onionsoup_propose_changes`. No plan is needed.
- **Architectural**: new subsystems, changes that restructure how components fit together, interfaces others depend on, or anything spanning several repositories. Questions, approaches, sectioned design, then writing-plans.

When in doubt, take the heavier path. The ratchet is one-way: hidden complexity found mid-task upgrades the path. Stop, say so, and step up.

## Red Flags

| Thought | Reality |
|---------|---------|
| "This is too simple to need a design" | A bounded change gets two sentences in chat. It still gets them. |
| "I'll call it bounded and skip the plan" | Reaching for the lighter label is the doubt. Take the heavier path. |
| "The design is obvious, I'll start while they read it" | The gate is the approval, not the design's length. Present, then wait. |
| "I know this kind of app, so it's bounded" | Bounded measures the repository, not your familiarity. |
| "The spike works, so I'll keep the code" | A spike's output is an answer. Keeping the code is a new request. |
| "It grew, but I'm almost done" | Hidden complexity upgrades the path. Stop and say so. |
| "Nobody is here to ask, so I'll skip the design" | Delegated work still gets a design; you settle it alone and record assumptions. |

## Checklist

Classify first, announce the path, then create a todo per item on your path.

**Spike:**
1. Explore enough context to frame the probe
2. Present question and probe in two or three sentences
3. Get a nod
4. Investigate
5. Report a recommendation; revert throwaway edits

**Bounded:**
1. Explore context: files, docs, recent commits
2. Ask the clarifying questions that matter, one at a time
3. Present a short design in chat: approach, files touched, tests
4. Wait for an explicit yes
5. Implement with test-driven-development, verify, `onionsoup_propose_changes`

**Architectural:**
1. Explore context: files, docs, recent commits, your notebook
2. Ask clarifying questions, one at a time: purpose, constraints, success criteria
3. Propose two or three approaches with trade-offs and your recommendation
4. Present the design in sections scaled to their complexity; confirm each
5. Self-review the design (below)
6. Invoke writing-plans

## The Process

**Understanding the idea:**

- Check the current state of the repository first (files, docs, recent commits).
- Assess scope before detailed questions. If the request describes several independent subsystems, say so at once and help decompose it; each piece gets its own design, plan and pull request. Work that belongs in another owner's repository goes to that owner with `onionsoup_request_work`.
- Ask one question per message. Prefer multiple choice when it fits.
- When the person makes a decision worth keeping ("use Postgres, not SQLite"), record it with `onionsoup_record_decision`, quoting them.

**Exploring approaches:**

- Propose two or three approaches with trade-offs. Lead with your recommendation and why.
- Apply YAGNI ruthlessly: remove every feature the goal does not need.

**Presenting the design:**

- Scale each section: a few sentences if straightforward, up to 200-300 words if nuanced.
- Ask after each section whether it looks right.
- Cover architecture, components, data flow, error handling, and testing.

**Design for isolation and clarity:**

- Break the system into units with one clear purpose each, communicating through well-defined interfaces, understandable and testable on their own.
- For each unit you should be able to say what it does, how to use it, and what it depends on.
- Smaller, focused files are easier to reason about and to edit reliably. A file that keeps growing is doing too much.

**Working in existing code:**

- Explore the current structure before proposing changes. Follow existing patterns and the repository's code rules.
- Where existing code gets in the way of the work (a file grown too large, tangled responsibilities), include a targeted improvement in the design.
- Do not propose unrelated refactoring.

## Design Self-Review

Before moving to writing-plans, look at the agreed design with fresh eyes:

1. **Placeholders:** any "TBD", vague requirement or unanswered question? Resolve it.
2. **Consistency:** do sections contradict each other?
3. **Scope:** is it small enough for one plan and one pull request?
4. **Ambiguity:** could a requirement be read two ways? Pick one and say which.

## After the Design

Do not write a spec file into the repository unless the repository's own conventions call for design documents. The plan you submit carries the design: goal, architecture, global constraints, and tasks.

Invoke writing-plans. It is the only skill that follows brainstorming on the architectural path.
