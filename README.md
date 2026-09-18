# Onionsoup

Small OSS maintenance agents with explicit jobs, shared data contracts, and
inspectable results. Built with [AgentLayer](https://github.com/humanlayer/agentlayer)
and the [12-Factor Agents principles](docs/twelve-factors.md).

The first agent is **bug-report readiness**: given one issue snapshot, decide
whether a maintainer has enough information to investigate. It returns a request
`kind` separately from `bug_readiness`. Bug reports are
`ready` or `needs_information`, with quoted evidence and focused questions. Feature
requests, support questions, and other or unclear requests get `not_applicable`;
classification makes no decision about project acceptance.
It does not diagnose the bug or change GitHub.

The second agent is **code-location**: given a ready bug report and a pinned Git
commit, suggest code and tests a maintainer should read. It uses bounded source
inspection and returns exact citations with uncertainties. It does not diagnose
the cause, run repository code, or propose changes.

This is a proof of concept with an explicit handoff between two narrow jobs.
There is no team scheduler or shared conversation.
The [“taco-bell orchestration” design note](docs/composable-agents.md) captures the
goal: multiple orchestration tools composing the same focused agents into
different workflows, and the proposed next PoC to demonstrate a second consumer.

## Start locally

Requires Node 24+ and npm. If managed by mise, use `mise exec node@24.19.0 -- npm ...`.

```sh
npm ci
npm run verify
npm run demo
```

The demo runs the real AgentLayer loop against a **scripted model response**. It
needs no credentials and does not establish model quality. It saves a run record
under `runs/` and prints JSON. All inputs and outputs are local synthetic examples.

## Use a subscription

Copilot is the default provider; Codex is also supported. There is no silent
fallback between providers, and no API-key billing path in this proof of concept.

```sh
npm run triage -- login copilot
npm run triage -- models
export ONIONSOUP_MODEL=gpt-5.6-terra
npm run triage -- run examples/incomplete-bug.json
```

`gpt-5.6-terra` is the current evaluation model. Model comparisons are deferred;
prior comparisons remain historical evidence. New credentials are stored in the
ignored `.local/auth.json`, with mode 0600.

Existing AgentLayer or OpenCode credentials can be read directly:

```sh
export ONIONSOUP_AUTH_PATH="$HOME/.local/share/opencode/auth.json"
export ONIONSOUP_PROVIDER=copilot
export ONIONSOUP_MODEL=gpt-5.6-terra
npm run triage -- run examples/incomplete-bug.json
```

For Codex, set `ONIONSOUP_PROVIDER=codex` and a model supported by that subscription.
Use `npm run triage -- login codex` if the selected credential store has no Codex
entry. Provider token refresh may update the selected store. `models` currently
lists Copilot models only. Both adapters are included; the validation report records
which providers have actually been exercised.

To assess a GitHub issue's title and body, fetch a snapshot outside the agent:

```sh
gh api repos/OWNER/REPO/issues/NUMBER --jq '
  if .pull_request then error("Expected an issue, received a pull request")
  else {schemaVersion: 1, repository: "OWNER/REPO", number,
        updatedAt: .updated_at, title, body: (.body // "")} end' > issue.json
npm run triage -- run issue.json
```

Replace `OWNER/REPO` and `NUMBER` in both places. This agent assesses only the
supplied title/body, so start with new reports; it does not read comments or linked
attachments. Keep the source revision with the result and reassess if it changes.

## Use the maintenance inbox

```sh
npm run inbox -- refresh get-bb/bb
```

With the subscription configured above, this fetches a bounded window of GitHub
issues and assesses up to five new or changed reports with Terra. Open
`runs/inbox/get-bb--bb/index.html` to browse the results, proposed questions,
waiting reports, and failures. There are no grading forms or GitHub writes.
Unchanged title/body content is reused; explicit retries preserve earlier attempts.
See [the inbox guide](docs/inbox.md) for bounds, freshness, recovery, and commands,
and [the live pilot record](docs/inbox-pilot-2026-09-18.md) for operational results.

## Locate investigation starting points

Choose one to three ready bug reports already in the inbox and an exact commit
in a local clone (bare clones work). With the same subscription configured:

```sh
npm run locate -- runs/inbox/get-bb--bb \
  --checkout .local/repos/get-bb--bb \
  --commit 3a4288bd0f34f888a5eb43f1099f7b60fe86eea4 \
  --issues 3773,3607,3899
```

This uses Terra, saves each brief and its inspected evidence, and attaches it to
the matching inbox card. Repeat the command to reuse completed results without
model calls. Fetching source and selecting its commit happen outside the agent.
See [the code-location contract and operating guide](docs/code-location.md).
The [three-report development pilot](docs/code-location-pilot-2026-09-18.md)
records both useful pointers and search-quality limitations.
The [search/test-selection follow-up](docs/code-location-search-2026-09-18.md)
records the v4 improvements, retained failures, and remaining relevance limits.
The [v5 follow-up](docs/test-selection-2026-09-18.md) adds fixture-to-assertion
navigation and records both its gains and remaining selection/summary failures.
`npm run eval:location` runs five small Terra-only search regression cases,
including misleading paths, embedded instructions, distant fixture consumers,
and behavior assertions versus lifecycle tests, using the configured
subscription. Source navigation and submission reserves are documented in the
code-location guide.

## Export a portable investigation packet

```sh
npm run packet -- issue.json --checkout .local/repos/get-bb--bb \
  --commit 3a4288bd0f34f888a5eb43f1099f7b60fe86eea4 --provider copilot
```

This invokes readiness and, for ready bug reports, code-location on Terra. It
writes `packet.md` and a self-contained `packet.json` under a new `runs/packets/`
directory. `--readiness RUN.json` reuses an exactly matching completed readiness
record from the selected subscription and current prompt; pass the raw run record,
not an inbox wrapper. `--output NEW_DIRECTORY` chooses the destination (its parent
must already exist). Existing directories are never overwritten or retried.

`npm run packet -- render DIRECTORY` regenerates Markdown from JSON without model
calls or credentials. Non-bug and incomplete reports retain their classification
or questions; failed location attempts yield a partial packet. See the
[packet contract](docs/investigation-packet.md) for lifecycle and portability.
The [five-report Terra pilot](docs/packet-pilot-2026-09-18.md) includes two repeats
and an assistant review of code/test relevance and consistency.

## Evaluate and inspect

```sh
npm run eval
```

This runs twelve synthetic development cases through **gpt-5.6-terra** on the
configured live subscription and uses its quota. Evaluation pins Terra explicitly;
`ONIONSOUP_MODEL` remains available for individual `triage run` invocations.
Expected outcomes are held outside the prompt. Run records include
the snapshot, its hash, model/provider, prompt version, timestamps, step/tool events,
usage reported by AgentLayer, termination reason, and final AgentLayer state.
See [validation](docs/validation.md) for measured results and limitations.
The [first real-issue pilot](docs/bb-pilot-2026-09-18.md) exposed judgment failures
in the mini model; do not infer task reliability from the offline demo or the
original six-case result.

For a frozen Terra-only real-issue batch with human feedback, use the
[batch evaluation workflow](docs/batch-evaluation.md). The historical
[40-issue Terra/Luna evaluation](docs/bb-heldout-2026-09-18.md) keeps runtime
success separate from human acceptance and requires an explicit cost decision
before recommending a supervised pilot.

`ONIONSOUP_RUNS_DIR` changes the output directory. Run files contain issue text and
model output; keep them local. A failed run exits nonzero. A valid assessment exits
zero, including non-bug classifications, because the
assessment itself succeeded. New outputs use contract v2 and prompt v4; historical
v1 outputs retain their original labels and can still receive feedback.

## Repository skills and contracts

The four skills in [skills/](skills/) cover [scope/contracts](skills/agent-contract/SKILL.md),
[prompts/context](skills/agent-context/SKILL.md), [execution/recovery](skills/agent-execution/SKILL.md),
and [evaluation/visibility](skills/agent-evaluation/SKILL.md). `.agents/skills`
links to this directory for discovery, and [AGENTS.md](AGENTS.md) provides routing.

The [readiness contract](docs/bug-readiness.md) and
[code-location contract](docs/code-location.md) explain success, evidence,
authority, failure, and handoff. [The twelve-factor mapping](docs/twelve-factors.md)
explains what is implemented now and what is intentionally deferred. These
contracts are the starting point for a future team; there is no team runtime yet.
