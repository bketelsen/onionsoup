# Frozen batch evaluation

This contract governs frozen issue batches, model runs, local review, and the evidence used to decide readiness for a pilot.

## Interface

The batch workflow tests the existing bug-report readiness agent on new issue
snapshots. It adds collection and human feedback outside the agent;
the agent still receives one title/body snapshot and cannot change GitHub.

New evaluations use **gpt-5.6-terra only**, with contract v2 and prompt v4. A model
comparison harness is deferred. The [earlier Terra/Luna batch](../plans/records/bb-heldout-2026-09-18.md)
remains readable with its original v1 labels and feedback; it cannot be rerun by
the current evaluator. Historical outcomes are never silently reclassified.

### Collect and run

Collection requires an authenticated `gh` CLI. Model execution uses the selected
subscription and consumes its quota.

```sh
npm run batch -- collect get-bb/bb runs/bb-terra-v4 \
  --count 40 --seed terra-v4 --provider copilot

export ONIONSOUP_AUTH_PATH="$HOME/.local/share/opencode/auth.json"
npm run batch -- run runs/bb-terra-v4
```

Use a new directory for each batch. The example above collects a development
batch; it does not guarantee that cases are unseen. Before claiming held-out
quality, exclude previously inspected cases (for example with an appropriate
`--before` cutoff) and check the selected snapshots against previous batches.
Collection fetches at most three pages of the latest open issues, excludes pull
requests and, when supplied, issue numbers at or above `--before`. It then selects
deterministically using the seed. It balances simple text-based buckets: short, feature,
intermittent, and detailed reports. These buckets guide sampling; they are not
ground-truth labels. This is not a representative random sample of all issues.
Invalid or oversized snapshots are excluded and counted.

`manifest.json` freezes the snapshots, their hashes, selection settings, model
IDs, prompt text/version, relevant runtime file hashes, and graduation criteria
before any assessment runs. Comments and linked attachments are excluded. New
batches contain one Terra assessment per snapshot. The CLI has no model
comparison option; historical manifests retain their original model lists.
There is no automatic provider fallback or escalation to a stronger model.

Each assessment retains the existing three-step, 60-second bounds. Admission and
final records are written atomically. An exclusive batch lock prevents duplicate
concurrent execution. Rerunning skips completed **and failed** records, preserving
the original denominator and failures. An interrupted `running` record stops the
batch for inspection; it does not resume model state. After a process crash,
inspect the recorded PID and records before removing a stale `.run.lock`. Put
intentional retries in a separate batch. Do not modify frozen runtime files while
running or silently replace failed results.

### Review locally

```sh
npm run batch -- report runs/bb-terra-v4
```

Open `runs/bb-terra-v4/report.html` in a browser. It contains the frozen
source, the assessment, run details, and a feedback form. It displays request
kind and bug readiness separately. Historical comparison reports still show their
original candidates and explicitly identify legacy v1 outcomes.

Enter your reviewer name and select operator or project maintainer. The role is
self-reported, not verified. For each assessment choose:

- **Accept:** usable unchanged, with no defect flags.
- **Revise:** useful after a correction; explain the correction in notes.
- **Reject:** unusable, including a failed run; explain why.

Flag false-ready decisions, unnecessary questions, overlooked evidence, and
unsupported claims. Judge the supplied snapshot only. In particular, `ready`
means enough information to begin investigation, not that the reported bug is
confirmed or reproducible by the reviewer. Evidence quoting is mechanically
checked; whether the quote supports the field requires human judgment.

Ratings start blank. Browser drafts may be saved in local storage, but export
feedback before closing the page. Export/download and loading a saved feedback
file also work without local storage. Import the downloaded file to persist
feedback and regenerate the report:

```sh
npm run batch -- import-feedback runs/bb-terra-v4 ~/Downloads/feedback.json
```

Use the actual downloaded filename. Partial reviews can be imported repeatedly.
Imports validate batch, issue, model, and run identity before writing anything.
Identical reviews are idempotent; corrections append to the local feedback ledger,
and the latest review per assessment supplies the metrics. Unchanged imported
reviews retain their original reviewer attribution. Header metrics update when
the CLI regenerates the report, not while editing the form. No feedback is posted
to GitHub.

### Decide whether to proceed

The predeclared gate is at least 30 cases, all assigned cases completed and
reviewed, at least 90% accepted unchanged, zero false-ready decisions, and an
explicit cost decision. With 40 cases this means at least 36 accepted assessments
per model. Until all cases are reviewed, overall acceptance is unknown. Unreviewed
false-ready counts are unknown rather than zero.

SDK token counts and elapsed time are observations, not a subscription bill or
quota measurement. `quotaConsumed` and `billedCost` remain null. After checking
your own subscription usage, record your decision separately:

```sh
npm run batch -- cost runs/bb-terra-v4 gpt-5.6-terra \
  --acceptable yes --reviewer YOUR_NAME --note 'Explain the observed quota impact'
```

A passing result permits a supervised pilot within the same narrow task. It does
not authorize autonomous replies or a broader maintenance agent. Cost is judged
for the current Terra configuration; speed alone is not a
promotion criterion. A structured model comparison can be introduced separately
later. Operator feedback can guide development, but project-maintainer review is
stronger evidence of usefulness.

After reviewing, turn specific failure patterns into development cases. If the
prompt changes, this batch becomes development evidence: evaluate the new prompt
on a fresh frozen set before claiming an independent quality result.

### Artifacts and checks

`summary.json` contains machine-readable metrics; `report.md` and `report.html`
present the results. `records/<model>/<issue>.json` contains original run records.
The manifest, records, and append-only feedback history remain local under ignored
`runs/`; source text and model output are included.

`npm run verify` covers selection, freeze enforcement, duplicate execution,
interrupted records, feedback validation and revision history, report escaping,
and the graduation gate using scripted models. These checks establish workflow
behavior, not live model accuracy.

## Rules

New development batches use Terra only. Frozen inputs and expected judgments remain outside the model prompt. Runtime completion MUST NOT be reported as independent human acceptance.

## References

- Rationale: [ADR-0004](../adr/0004-compose-bounded-maintenance-agents.md).
- Context: [agent design](../design/agents.md),
  [twelve factors](../design/twelve-factors.md),
  [composition](../design/composable-agents.md),
  [validation](../design/validation.md).
- Delivery and evidence: [roadmap](../plans/roadmap.md),
  [evaluation plan](../plans/evaluations.md).
