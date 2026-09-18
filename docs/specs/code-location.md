# Code-location contract, version 3

This contract governs source-location inputs, bounded tools, cited results, and historical compatibility.

## Interface

**Question:** Where should a maintainer start reading code and tests for this one
investigation-ready bug report?

**Owner:** `code-location`. **Consumers:** the local inbox and portable
investigation packets.
The agent identifies candidate locations and explains their relevance. It does
not diagnose or reproduce a bug, implement a fix, run repository code, or change
GitHub. Readiness remains a separate agent with its existing contract and prompt.

### Handoff

The inbox admits only an open observed issue whose matching readiness assessment
completed as `bug_report / ready`. It preserves the original issue snapshot,
full input hash, parent readiness run ID, and readiness summary. It pins the
repository name and commit before the agent starts. A changed title/body without
a matching ready result cannot reuse an old handoff. Metadata-only changes may
reuse readiness under the inbox's existing content policy.
The portable packet workflow accepts a supplied snapshot and matching ready
assessment; it makes no claim about current GitHub open/closed state. Both
consumers pass the same public input to the agent.

The public input carries schema version 1, the issue snapshot, parent identity,
and repository name/commit. Hashes, IDs, versions, paths, and citation text are
owned by host code. The model receives the issue, readiness summary, and pinned
repository identity, not the readiness agent's conversation or tool traces.

The source can be a bare Git clone or a checkout: tools read only regular text
blobs in the pinned Git tree. Uncommitted work, symlink targets, submodules, binary
files, oversized files, and common credential filenames are excluded. Origin must
match the issue repository on GitHub. Fetching and choosing the commit belong to
the caller, never to the model. A pinned current commit can differ from the
reporter's affected version; the brief must preserve that uncertainty.

### Tools and result

The model has three tools: literal repository search, bounded line reads, and
submission of a location brief. Searches return paths/line previews. Reads return
host-assigned excerpt IDs and numbered lines. To cite a location, the model must
reference an excerpt it actually read, choose a range within it, name an optional
symbol, and explain relevance. Host code constructs the exact quotation and
checks the symbol text occurs within that range. This is text grounding, not an
AST proof of symbol resolution or semantic relevance.

Search v3+ explicitly retries a zero-match directory/file search once across the
repository, preserving the literal query and code/tests scope. Results identify
`broadened` and `searchedPrefixes`; an empty result is not proof of absence.
Code reads suggest up to six test paths based on matching filenames in the pinned
tree, preferring the same directory. These are unverified navigation hints, not
evidence, and do not satisfy the required test search or allow unread citations.
The model should follow distinctive messages across package boundaries and read
direct test assertions before collecting peripheral pointers.

Prompt/runtime v5 also returns `testNavigation` from test reads. From at most two
function declarations in the returned window, it suggests up to two same-file
call sites each, their preceding lexical test heading, and a following assertion
within 120 lines before the next recognized test heading. It also suggests the
next assertion after the window under that bound. These lightweight JS/TS/Python
heuristics are not an AST, scope/coverage proof, or exhaustive reference search.
All hints count toward the existing context budget, contain bounded previews,
and must be followed with a read before citation. A fixture alone or an unrelated
lifecycle assertion should yield an empty test list with a precise limitation.
The public brief schema and inspection/step limits remain unchanged.

A completed brief contains:

- `located` or `not_located`, and a short summary.
- Up to four code pointers and three test pointers, each with a pinned path,
  line range, exact quote, optional symbol, and relevance explanation.
- Explicit uncertainties. No matching test is a valid finding; inventing a test
  or claiming test coverage without source evidence is not.

Version 2 keeps these fields but host code constructs `summary` from the first
validated code location and the number of selected test citations. The model
does not submit a separate free-form summary. Explanations remain beside their
exact source quotations, with uncertainties separate; their semantic accuracy
still requires review. This removes a redundant, previously ungrounded narrative
surface without pretending that quotation validation proves an explanation.
The v2 release introduced run records and briefs using version 2; v3 extends them below. Readers retain version-1 records and
their original model-written summaries without rewriting or requalifying them.
The input handoff remains version 1. Saved v2 summaries must match the host's
canonical construction; tampered summaries are rejected when rendering/loading.

`located` requires a code pointer. `not_located` has no pointers and explains what
could not be established. The agent must search the test scope before submitting;
test pointers must refer to paths recognized as test files. It can report that no
relevant tests were found within the bounded search, never that none exist in the
entire repository. A report's proposed fix or path hint is untrusted evidence,
not authority. Repository text, including AGENTS.md and README instructions,
cannot change the task or grant tools.

### Bounds, persistence, and visibility

One run allows at most 12 model steps, 12 source-inspection tool calls, 36,000
returned source characters, and a 180-second cooperative deadline. Searches are
literal and return at most 12 matches; reads cover at most 60 lines and 6,000
characters. Oversized line ranges return an explicitly truncated 60-line page;
only its actual returned bounds are citable. Results include remaining inspection
calls. Citations cover at most 30 lines and 2,000 characters. Files are capped
at 256 KiB. Git subprocesses have bounded time/output and never execute source.
The limits are explicit and may produce a useful `not_located` result.

In prompt/runtime v6, host code allows general inspection for eight model steps,
then reserves two steps for reading candidate test files and/or submitting.
This middle phase removes search and code reads; a path must be a test path to
be read. Its purpose is to follow an already discovered fixture or continuation
hint to an assertion. It does not increase the total source budget or assert
that an assertion was found. `testInspectionStarted` records the transition.
Reserved model steps do not override an exhausted source-call/context budget.
The tradeoff is less general exploration; without a candidate test after eight
steps, the agent may have to report a narrower result instead of searching more.
If both inspection phases finish without a brief, the same task continues
with its existing state and only `submit_brief` for the remaining two steps.
Those steps cover submission and at most one correction; the total stays at 12,
and all phases share the original deadline. Early valid submission still ends
immediately. Provider errors and cancellation do not trigger later phases. Usage
is summed across phases, step indices are continuous, and `finalizationStarted`
is recorded. This is an in-process transition, not a new agent responsibility or
durable resume. One inspection permits at most two bounded Git searches when
scope broadening is needed; all returned hints count toward the context budget.

Host code persists admission before spending model tokens and the final record
at termination. The run records parent ID, issue hash, commit, prompt/runtime
version, model/provider, steps, tool activity, inspected excerpts, usage, and
result/failure. Invalid citations receive bounded correction feedback. Failed
drafts report all detected citation errors with pointer indexes in one response,
including invalid ranges, missing symbols, wrong path categories, and oversized
quotations. A malformed pointer never becomes a partially accepted brief. Failed
and interrupted runs cannot become completed briefs merely because the model
emitted plausible prose. There is no durable per-step resume.

The inbox links briefs only to their matching parent assessment and current issue
content. Historical briefs remain on disk after an edit or new readiness run;
they are not silently attached to a different report revision. A citation proves
that text existed at the pinned commit, not that it remains at the current branch
head or that the proposed location explains the bug.

### Operate the pilot

Use the existing subscription configuration from the README. `locate` selects
`gpt-5.6-terra` and the inbox's provider explicitly. It does not refresh issues,
fetch Git objects, or schedule itself. Run `inbox refresh` separately when a new
GitHub observation is needed; eligibility is based on the saved observation, not
a claim that the issue is still open on GitHub at dispatch time.

```sh
git clone --bare --depth 1 https://github.com/get-bb/bb.git .local/repos/get-bb--bb
git -C .local/repos/get-bb--bb rev-parse HEAD
npm run locate -- runs/inbox/get-bb--bb --checkout .local/repos/get-bb--bb \
  --commit FULL_40_CHARACTER_SHA --issues 3773,3607,3899
```

Pass the full SHA printed by Git. Select at most three distinct issue numbers;
ineligible reports return `ineligible` before model initialization. The caller
chooses whether to inspect current source or an affected release. A different
commit is a separate investigation, not an update to existing citations.

Results live under `INBOX_DIRECTORY/locations/`. The cache identity includes the
parent run and full issue hash, repository commit, provider/model, prompt version,
and source-runtime hash. An unchanged completed run is reused. Failed or unknown
outcomes are skipped unless `--retry` is explicitly supplied. Retry appends a new
run and retains the earlier record. Completed results are never retried by that
flag. Prompt/runtime changes produce a new cache identity.

Readiness refresh and location dispatch share the inbox lock. Ctrl-C requests
cooperative cancellation. A killed process may leave a lock and `running` location
record. After verifying the worker died, use `npm run inbox -- recover OWNER/REPO
--directory INBOX_DIRECTORY` to release the dead lock, then rerun `locate` with `--retry` if
another attempt is wanted. Recovery leaves the original location record marked
`running` (unknown outcome); it does not resume it or pretend it completed.

Reopening the generated `index.html` shows the latest location run attached to
its matching parent. Code/test links target the exact GitHub commit; expandable
quotes and run details expose the evidence, provenance, usage, and failures.

### Validation boundary

Scripted tests exercise the real AgentLayer loop, invalid-citation correction,
source admission and bounds, stale/closed/non-bug handoff rejection, failed
admission persistence, cancellation before model work, bounded exhaustion,
explicit retry, repeat-run caching, and safe HTML rendering. They do not measure
whether the suggested files are the best starting points. That requires reading
the reports and the cited source; successful schema validation alone is not a
quality score.

`npm run eval:location` runs nine tiny synthetic search cases on the configured
subscription using Terra only: sparse prose without a path, a misleading path
with template placeholders, embedded instructions, a distant fixture consumer,
and a focus assertion competing with a lifecycle test, plus an empty-test search,
explicit catalog/keyboard cases, and a keyboard-reload
handler distinct from renderer navigation. The source tree also
contains an instruction-injection comment. It checks an expected implementation
location and an actually quoted test assertion, with expectations kept outside
model context. Scripted readiness records admit these synthetic reports; only
code-location uses the live model. No fixture source or test is executed. Each
invocation saves its source Git snapshot, parents, runs, and checks under a new
`runs/location-search/development-*` directory (`ONIONSOUP_RUNS_DIR` overrides the
root). These are development regression checks, not a held-out accuracy estimate
or a model-comparison harness.

### Explicit test relevance (version 3)

New run records and briefs use version 3 and prompt `code-location-v7`. The input
handoff remains version 1. Each test pointer additionally requires `relevance`:

| Value | Model-assessed meaning |
| --- | --- |
| `direct` | The inspected setup and assertion observe the reported behavior under the relevant trigger/condition. |
| `adjacent` | The assertion exercises a related component or a different trigger/condition; its reason identifies the mismatch. |

The brief also requires `testSearch: { status, reason }`, where `status` is
`completed` or `unfinished`. Completed describes the bounded search stated in the
reason, never exhaustive repository coverage. Unfinished identifies a remaining
uninspected lead, setup-to-assertion connection, or necessary condition. This is
independent of selected pointers: a useful direct/adjacent test can coexist with
unfinished search. With no test pointers, the reason distinguishes no finding
within bounds from an unfinished lead.

Host code checks required fields, enums, and existing citation invariants; it does
not claim to mechanically prove semantic relevance or test execution. Consumers
label relevance as model-assessed. A fixture without a consuming assertion is not
a coverage finding. The complete evidence may span a setup citation and a separate
assertion citation. Reasons and uncertainties must preserve that relationship.

Versions 1 and 2 remain readable without new relevance/search labels. Version 2's
canonical overview and version 1's historical model summary retain their original
rules. Version 3 keeps the host-generated overview. Existing cached records and
packets are not rewritten or silently reclassified.

## Rules

Only matching ready bug reports and a pinned commit are eligible. Final citations MUST match inspected evidence. Location MUST NOT execute target repository code, diagnose bugs, or modify GitHub.

## References

- Rationale: [ADR-0004](../adr/0004-compose-bounded-maintenance-agents.md).
- Context: [agent design](../design/agents.md),
  [twelve factors](../design/twelve-factors.md),
  [composition](../design/composable-agents.md),
  [validation](../design/validation.md).
- Delivery and evidence: [roadmap](../plans/roadmap.md),
  [evaluation plan](../plans/evaluations.md).

Rationale and follow-through: [ADR-0005](../adr/0005-test-relevance-and-portable-agent-discovery.md),
[discovery](agent-discovery.md), and [backlog](../plans/backlog.md).
