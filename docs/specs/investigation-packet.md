# Portable investigation packet, version 1

This contract governs the portable CLI/function consumer and its Markdown and JSON artifacts.

## Interface

This is a second consumer of bug-readiness and code-location. It assembles their
validated artifacts into Markdown for a person and JSON for another application.
Assembly is deterministic and adds no model-written summary or new agent role.

Input is one version-1 issue snapshot and a caller-selected repository checkout
and full commit. An optional completed version-2 readiness run may be reused only
when its full snapshot hash, provider/model, and current prompt match. This
workflow assesses the supplied snapshot; it does not claim live GitHub freshness
or infer whether an issue is open. Fetching source and choosing reports belong
to the caller.

Only `bug_report / ready` proceeds to code-location. Other kinds or reports needing
information yield a completed assessment packet with their classification,
evidence, and questions. Classification implies no project acceptance decision.
A ready bug with failed location or no located code yields a partial packet.
Readiness failure yields a failed packet. Running records have an unknown outcome.

The JSON embeds both run records, the issue snapshot/hash, repository commit,
packet identity, execution choice, and explicit stage/status. Parent identity and
source quotations remain those of the agents. Markdown escapes untrusted prose
and quotes evidence in fenced blocks; links target the pinned commit. No source
or tests are executed and no GitHub writes occur.

Each invocation requires a new output directory and persists admission before
provider initialization, followed by stage checkpoints and final artifacts.
Existing directories are rejected rather than overwritten or implicitly retried.
Reusing readiness spends no readiness tokens; repeat location trials intentionally
create new attempts. There is no cross-packet cache or automatic retry. Each agent
retains its deadline; the workflow has a shared 240-second cooperative deadline.
Interrupted processes may leave a running packet; rendering it does not resume it.
Markdown can be regenerated from packet JSON without credentials or model calls.

The packet workflow requires neither an inbox directory nor its configuration,
index, record wrappers, locks, or HTML. The CLI is one adapter to the callable
workflow and deterministic renderer. Provider/model selection is explicit at the
application edge; current runs use the chosen Copilot/Codex subscription and Terra.

### CLI and callable boundary

```sh
npm run packet -- issue.json --checkout .local/repos/get-bb--bb \
  --commit 3a4288bd0f34f888a5eb43f1099f7b60fe86eea4 --provider copilot
npm run packet -- render runs/packets/PACKET_DIRECTORY
```

Use `--readiness RUN.json` to supply a raw completed readiness record, rather than
an inbox record wrapper. `--output NEW_DIRECTORY` selects an exclusive destination
whose parent must exist. Without it, the CLI creates a UUID-named directory under
`runs/packets/`. Exit status is zero for completed packets, including requests
needing information, and nonzero for partial/failed packets or rejected input.

[`src/packet.ts`](../../src/packet.ts) exports the `Packet` v1 type, `validatePacket`,
`createPacket`, and `packetMarkdown`. `createPacket` accepts an issue snapshot plus
the output directory, checkout, commit, provider, optional readiness record, and
optional cancellation signal. `packetMarkdown` accepts only the embedded packet;
it needs neither a source checkout nor credentials. Embedding records preserves
their original agent contracts, events, inspected excerpts, and reported usage.
Current code-location records/briefs use version 2, including a host-generated
overview. Historical version-1 location records remain readable without rewriting
their model-written summaries. The packet envelope remains version 1; consumers
must inspect the nested agent record's version independently of the envelope.
Validation checks internal identity and excerpt grounding; it is not a signature
or independent verification that a supplied artifact came from its claimed host.

JSON is atomically checkpointed before Markdown is written. A crash between those
writes can leave Markdown behind the JSON; `render` regenerates it. Running JSON
remains an unknown outcome and is never silently resumed. A new attempt uses a
new output directory. Consumers should use status/disposition, not file existence,
to decide whether an investigation is available.

The [five-report pilot and two repeats](../plans/records/packet-pilot-2026-09-18.md) demonstrate this
consumer independently of the inbox, including a fresh readiness outcome that
correctly withheld code-location. This is a local application adapter, not yet a
demonstration with an external orchestration product.

## Rules

The packet MUST preserve original agent records and provenance. Failed location is an explicit partial result. Rendering MUST NOT add unsupported model claims or require a model call.

## References

- Rationale: [ADR-0004](../adr/0004-compose-bounded-maintenance-agents.md).
- Context: [agent design](../design/agents.md),
  [twelve factors](../design/twelve-factors.md),
  [composition](../design/composable-agents.md),
  [validation](../design/validation.md).
- Delivery and evidence: [roadmap](../plans/roadmap.md),
  [evaluation plan](../plans/evaluations.md).
