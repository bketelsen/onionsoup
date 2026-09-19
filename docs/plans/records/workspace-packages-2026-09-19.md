# Evaluation record: Portable workspace packages — 2026-09-19

Historical evidence appendix to [the evaluation plan](../evaluations.md), phase 19.
This is an assistant-run software qualification, not a new model-quality evaluation.

## Method and boundaries

Extracted the repository-brief and scheduled-delivery implementation from source
revision `971d429` into six private packages and four thin applications, all version
0.1.0. Prompts and version-1 brief/delivery records are unchanged; repository-analysis
capability manifests advance to version 2 for their new package import surface.
AgentLayer stays at 0.0.36, the MCP SDK at 1.30.0, and Node at 24.19.0. Terra remains
the development policy; scripted AI SDK models and synthetic repository evidence
exercise transport/runtime behavior without subscription calls.

The deployment test copies the compiled release to a new temporary directory,
installs production dependencies from the lockfile, and invokes compiled entrypoints
without TypeScript source or developer dependencies. It compares saved JSON,
Markdown, HTML and event output byte-for-byte, prepares a frozen delivery without
sending, and connects a real MCP stdio client. A deliberately unavailable synthetic
`gh` command proves collection failure remains visible and spends no model budget.

## Results and evidence

- Portable CLI rendering preserves the original workflow identity and all four
  artifact files. The worker prepares the same brief for delivery without analysis
  replay. MCP admits a job, exposes its saved failure and enforces admission limits.
- In-memory MCP tests exercise successful scripted inference, saved event/render
  equality, inspection after restart, unfinished admission, mismatch detection,
  cooperative cancellation, concurrency, authority substitution and storage failure.
- Tampering with compiled code causes release inventory verification to fail.
- Compatibility tests confirm legacy entrypoints resolve the same function objects.
- Initial regression run found only stale generated capability manifests; regeneration
  aligned their version/import metadata. The first deployment checks exposed the
  capture CLI's missing help handling and a test fixture omitting required limitations;
  both were corrected before qualification.

Final `npm run verify` passed: **207 tests, 207 passed, zero skipped**, with the
fixture runtime, Go checkout/runtime/dependencies, Node task checkout/dependencies,
and portable-release install enabled. Documentation checks covered 90 indexed
documents, 13 skills and five instruction symlinks. Public dependency checks covered
ten workspaces. The generated catalog check and TypeScript checks also passed.
A subsequent full run exposed a discovery consumer assuming every module was a
relative source path; it now resolves package names directly, with both forms documented.

## Limitations and next step

No fresh live-model quality claims, human acceptance, live homelab access, external
mail forwarding or public service deployment are established. The portable proof
uses a local stdio MCP host and a scripted model. Durable job inspection survives
restart; execution does not resume automatically. The release inventory is unsigned.
The remaining readiness/location/implementation code still lives in the legacy root
application, including its previously qualified sandbox assets. Future extractions
must prove their own asset and runtime-identity closure.

Next define a read-only homelab evidence contract and configured resource allowlist,
incorporating the existing TrueNAS MCP server alongside Incus/container/NAS sources.
No homelab service mutation is authorized by this package extraction.

## References

- Plan phase: [evaluation phase 19](../evaluations.md#phase-19--portable-package-qualification),
  [roadmap phase 21](../roadmap.md#phase-21--reusable-packages-and-thin-applications).
- Rationale: [ADR-0022](../../adr/0022-package-capabilities-with-thin-host-applications.md).
- Context: [package design](../../design/packages-and-recipes.md).
- Contract: [workspace packages](../../specs/workspace-packages.md).
