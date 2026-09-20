# Spec: Persistent chat and homelab profile

A reusable AgentLayer conversation runtime answers one user turn by delegating to
reviewed profile capabilities. The first profile handles homelab investigation,
evidence explanation, refresh and briefs. A thin CLI consumes the same API.

## Interface

- `@onionsoup/chat`: `openChatSession`, `chatTurn`, `closeChatSession`, session and
  answer schemas, budgets and persistence. No dependency on homelab or MCP.
- `@onionsoup/homelab-chat`: profile factory accepting a bounded MCP caller and
  immutable host binding. No shell, credential loading or application imports.
- `apps/chat-cli`: explicit provider, operator-owned MCP config, session directory,
  interactive input or `--message`, optional selected target, and controlled stdio
  launch of the existing homelab host.

Answers are structured `answer`, `clarification` or `unsupported`, with text and
job/finding references. Host evidence metadata includes age, scope/coverage,
deterministic counts and provenance independently of model prose. Clarifications
end the turn and persist the question; the next message is a new bounded turn.

## Rules

- Twenty turns per session; eight logical model steps, twelve delegated tool calls
  and 600-second cooperative deadline per turn. At most one investigation, one brief
  and four fixed source refreshes per turn; sixteen child admissions per session.
  Reservations persist before remote effects and are never refunded on failure.
- Model/provider/profile binding is fixed at session creation. CLI pins Terra with
  an explicitly selected Copilot/Codex subscription. Credentials remain external.
- Before each question the CLI checks local provider setup. Missing or unreadable
  authentication produces fixed setup instructions without spending a turn or child
  admission. Raw provider errors and credential contents are never displayed.
  Saved runtime failures distinguish initialization, provider request failure,
  step exhaustion and failure to submit an answer; legacy `execution_failed`
  records remain readable. Initialization alone is not a model invocation.
- Each session has one exclusive writer. Sessions and MCP jobs use separate private
  directories. Clean shutdown releases locks; after a crash the operator verifies
  processes have stopped before removing stale locks. Interrupted turns are recorded
  on reopen without automatic model invocation, retry or effect replay.
- Full user messages and concise answers persist privately. Model context includes
  at most four recent turns, the selected target and bounded job references. Follow-up
  evidence is re-inspected through MCP, not inferred from cached summary prose.
- Tool arguments are parsed in executors. Profiles register a fixed reviewed tool
  set; discovery and untrusted tool content cannot add capabilities or widen authority.
- Current-evidence answers require fresh evidence at submission. Snapshot/explanation
  answers may cite stale evidence with host-rendered age. A request for refresh
  triggers only configured source collectors; unavailable refresh remains explicit.
- A profile with multiple workload targets requires an operator-selected target;
  otherwise the agent asks a clarification. A single target may be selected by default.
- No shell, logs, service writes, generic network, credential/path selection or repair
  is exposed. Unknown observations and partial refreshes cannot imply healthy defaults.
- Admission, tool intents, child identities, response hashes and terminal usage are
  persisted. Unknown provider usage remains unknown; session totals distinguish it.
  Evidence bodies stay in host artifacts; the session saves references and metadata.
- Persistence failure stops further work. Cancellation is cooperative. An admission
  response lost after a remote effect remains unknown; there is no exactly-once claim.

## References

- Rationale: [ADR-0028](../adr/0028-separate-chat-sessions-from-domain-capabilities.md).
- Context: [package design](../design/packages-and-recipes.md).
- Delegation: [homelab MCP](workload-triage.md), [previous proof](homelab-delegation.md).
- Work: [roadmap phase 27](../plans/roadmap.md#phase-27--persistent-chat-and-homelab-profile).
- Evidence: [chat qualification](../plans/records/chat-2026-09-20.md).

## CLI examples and recovery

```sh
export ONIONSOUP_AUTH_PATH=/absolute/private/subscription-auth.json
npm run chat -- --config .local/homelab/chat-mcp.json --provider copilot
# Print the path on startup; resume that exact directory with the same configuration:
npm run chat -- --config .local/homelab/chat-mcp.json --provider copilot \
  --session runs/chat/SESSION --resume
# A single turn, useful for scripts and recorded qualification:
npm run chat -- --config .local/homelab/chat-mcp.json --provider copilot \
  --session runs/chat/SESSION --resume --message 'Explain the first attention finding.'
```

Set the authentication environment variable in the same shell that launches chat.
Without it the default is `.local/auth.json` relative to the working directory.
Alternatively, `npm run triage -- login copilot` (or `codex`) sets up that store.
`--status` and interactive session commands do not require provider credentials.

Interactive `/status` shows session IDs, job references, admissions and parent token
usage (unknown invocations are counted separately); `/target ID` changes the selected
configured target and persists it; `/quit` closes cleanly. Ctrl-C cancels the active
turn. `--status` opens saved state without a model or MCP connection. `--message`
emits a structured turn with host-generated evidence metadata, useful for another UI.

A session has private `session.json` and an exclusive `.lock/owner.json` identifying
the local process. Normal restart reopens without any model/read calls until the
next question. An interrupted saved turn becomes `interrupted`; known jobs remain
inspectable. For SIGKILL or a machine crash, verify the prior processes are gone,
then remove only the stale session `.lock` and MCP `.host-lock`. This is explicit
operator recovery, not automatic lock stealing or workflow replay.

The session file is bounded to 2 MiB; profile memory to 64 KiB; user messages to
8 KiB; selected model context to 60 KiB; each tool response to 128 KiB. Common pasted
credential forms are rejected before saving a user message; this is not a general
secret detector. Do not paste credentials into chat. Full provider transcripts are
not saved. The historical single-turn proof remains a separate qualification tool.
