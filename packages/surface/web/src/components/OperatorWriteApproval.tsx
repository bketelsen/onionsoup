import type { OperatorWriteApproval } from '../../../src/operator-write-approval.ts';

const BLOCK = 'typography-code rounded bg-muted/30 p-2 whitespace-pre-wrap break-all max-h-40 overflow-auto';
function Creation({ approval }: { approval: Extract<OperatorWriteApproval, { mode: 'create-write' }> }) {
  return <div className="space-y-2">{approval.workspaces.map(workspace => <div key={workspace.id}>
    <div className="font-medium">{workspace.id}</div>
    {workspace.goal && <p className="whitespace-pre-wrap">{workspace.goal}</p>}
    <pre className={BLOCK}>{`Workspace: ${workspace.directory}\nBaseline head: ${workspace.head}\nApproved files:\n${workspace.files.join('\n')}`}</pre>
  </div>)}</div>;
}
function Acceptance({ approval }: { approval: Extract<OperatorWriteApproval, { mode: 'accept-write' }> }) {
  return <div className="space-y-2">
    <pre className={BLOCK}>{`Workspace: ${approval.directory}\nBaseline head: ${approval.head}\nScoped files:\n${approval.files.join('\n')}`}</pre>
    <div className="font-medium">Exact host-recorded diff</div>
    <pre className="typography-code rounded bg-muted/30 p-2 whitespace-pre-wrap break-all max-h-96 overflow-auto">{approval.diff || '(No file changes)'}</pre>
    <p>Child conclusions are model claims. This diff records file changes; acceptance does not certify tests or independent verification.</p>
    {approval.evidence && <code className="block break-all">Transcript: {approval.evidence.sessionID} / {approval.evidence.messageID}</code>}
  </div>;
}

/** Full scoped content remains available by scrolling; no hidden truncation changes what the person accepts. */
export function OperatorWriteApprovalView({ approval }: { approval: OperatorWriteApproval }) {
  return <section className="space-y-2 typography-meta" aria-label="Scoped operator write approval">
    <h3 className="font-medium">{approval.mode === 'create-write' ? 'Approve scoped file edits' : 'Accept completed file edits'}</h3>
    <div className="font-medium">Original request</div>
    <pre className={BLOCK}>{approval.intake}</pre>
    <div className="font-medium">Goal and constraints</div>
    <pre className={BLOCK}>{[approval.goal, ...approval.constraints].join('\n')}</pre>
    {approval.mode === 'create-write' ? <Creation approval={approval} /> : <Acceptance approval={approval} />}
  </section>;
}
