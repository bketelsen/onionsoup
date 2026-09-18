---
name: agent-release-manifest
description: Version the complete Onionsoup execution configuration and its evaluation evidence when preparing releases or changing reproducibility guarantees.
---

# Record a reproducible execution configuration

## Steps

1. Inventory behavior-defining inputs: code/runtime hash, prompt, schemas/tools, dependencies, provider/model configuration, and source or retrieval policy.
2. Record explicit versions or content hashes. Distinguish a requested model alias from an immutable provider revision; record unavailable resolution rather than claiming exact reproducibility.
3. Link evaluation results to dataset, evaluator/rubric, prompt, runtime, and model configuration. Separate scripted checks, synthetic development trials, and independent judgments.
4. Snapshot configuration at admission. Configuration changes create new attributable attempts; preserve historical results and their readers.
5. Verify artifact drift and compatibility before publication. Define rollback for code/configuration independently from whether the provider still serves an older model.

## Pitfalls

- A manifest does not justify a model-comparison harness, registry service, or new model selection.
- Do not include credentials, raw run data, or private source in published release metadata.
- Hashes establish identity, not task quality or byte-identical nondeterministic outputs.

Follow the [backlog](../../../docs/plans/backlog.md) and
[agent design](../../../docs/design/agents.md). For current discovery/export work,
read the [public contract](../../../docs/specs/agent-discovery.md).
Validate implementation changes with `npm run verify`; keep scope and permissions
within the user's request.

Adapted from [20-factor: 05-immutable-build-pipeline](https://github.com/trentas/20-factor/blob/6dc491097d016c9871c32bd214431f0079673533/_projects/05-immutable-build-pipeline.md),
with Onionsoup-specific boundaries and deferred-adoption criteria. This skill text
is licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
