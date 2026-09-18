# Onionsoup

Build focused OSS maintenance agents using AgentLayer. Keep one job per agent and
prove it useful before adding coordination infrastructure. Prefer Copilot and
Codex subscriptions; select provider and model explicitly at the application edge.

Repository skills live in `skills/`. Read the applicable skill when doing that work:

- `skills/agent-contract/SKILL.md`: define or change an agent's responsibility and public contract.
- `skills/agent-context/SKILL.md`: develop prompts, tools, and context assembly.
- `skills/agent-execution/SKILL.md`: implement state, execution, recovery, or human handoffs.
- `skills/agent-evaluation/SKILL.md`: evaluate behavior, instrument runs, or decide readiness.

Use `npm run verify` for code changes. Use `npm run demo` for a credential-free
AgentLayer smoke test. Scripted model tests do not establish task accuracy.
Run live evaluations only with a configured subscription; never log credentials.
Current development evaluations and new batches use `gpt-5.6-terra` only. Keep
historical comparison artifacts readable; defer a new model-comparison harness.
Contract v2 separates request kind from bug readiness; classification must not
imply project acceptance or rejection. Preserve v1 results without relabeling them.
Do not broaden the first agent into general triage, debugging, or GitHub mutation.
The separate code-location agent consumes only matching ready bug reports and a
pinned Git commit. It locates code/tests with grounded citations; it must not
diagnose bugs, execute repository code, implement fixes, or mutate GitHub.

The factor mapping and consciously deferred capabilities are in
`docs/twelve-factors.md`. Public contracts are in `src/contracts.ts` and
`docs/bug-readiness.md`. Code-location contracts are in
`src/location-contracts.ts` and `docs/code-location.md`.
