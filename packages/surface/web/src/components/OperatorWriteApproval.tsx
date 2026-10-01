import type { ReactNode } from 'react';
import type { OperatorWriteApproval } from '../../../src/operator-write-approval.ts';

const BLOCK = 'typography-code rounded bg-muted/30 p-2 whitespace-pre-wrap break-all max-h-40 overflow-auto';
export const OPERATOR_CHECK_DISPLAY_LIMITS = { outputChars: 16_384 };
type AcceptanceApproval = Extract<OperatorWriteApproval, { mode: 'accept-write' }>;
type ApplicationApproval = Extract<OperatorWriteApproval, { mode: 'apply-handoff' }>;
function Creation({ approval }: { approval: Extract<OperatorWriteApproval, { mode: 'create-write' }> }) {
  return <div className="space-y-2">{approval.workspaces.map(workspace => <div key={workspace.id}>
    <div className="font-medium">{workspace.id}</div>
    {workspace.goal && <p className="whitespace-pre-wrap">{workspace.goal}</p>}
    <pre className={BLOCK}>{`Workspace: ${workspace.directory}\nBaseline head: ${workspace.head}\nExisting files:\n${workspace.files.filter(path => !workspace.createFiles.includes(path)).join('\n') || '(None)'}\nNew files:\n${workspace.createFiles.join('\n') || '(None)'}`}</pre>
    <div className="font-medium">Approved check commands</div>
    {workspace.checks.length ? workspace.checks.map(check => <pre key={check.id} className={BLOCK}>
      {`${check.id}: ${JSON.stringify(check.command)}`}
    </pre>) : <p>No check commands approved.</p>}
  </div>)}</div>;
}
function CheckReceipt({ check }: { check: AcceptanceApproval['checks'][number] }) {
  const output = check.output ?? '';
  const isTruncated = output.length > OPERATOR_CHECK_DISPLAY_LIMITS.outputChars;
  return <div className="space-y-1">
    <pre className={BLOCK}>{`Check: ${check.checkID}\nReceipt: ${check.id}\nReceipt digest: ${check.digest ?? '(Not completed)'}\nCommand: ${JSON.stringify(check.command)}\nStatus: ${check.status}\nExit code: ${check.exitCode ?? '(Not completed)'}\nArtifact digest: ${check.artifactDigest}`}</pre>
    {check.runtime && <pre className={BLOCK}>{`Runtime: ${check.runtime.version}\nGo executable SHA256: ${check.runtime.binarySha256}`}</pre>}
    {output && <pre className={BLOCK}>{output.slice(0, OPERATOR_CHECK_DISPLAY_LIMITS.outputChars)}</pre>}
    {check.outputTruncated && <p>Host check output was truncated when recorded.</p>}
    {isTruncated && <p>Check output display truncated; the durable check receipt retains the recorded output.</p>}
  </div>;
}
function Acceptance({ approval }: { approval: AcceptanceApproval }) {
  return <div className="space-y-2">
    <pre className={BLOCK}>{`Workspace: ${approval.directory}\nBaseline head: ${approval.head}\nScoped files:\n${approval.files.join('\n')}`}</pre>
    <div className="font-medium">Exact host-recorded diff</div>
    <pre className="typography-code rounded bg-muted/30 p-2 whitespace-pre-wrap break-all max-h-96 overflow-auto">{approval.diff || '(No file changes)'}</pre>
    <div className="font-medium">Host check receipts</div>
    {approval.checks.length ? approval.checks.map(check => <CheckReceipt key={check.id} check={check} />)
      : <p>No host check receipts recorded.</p>}
    <p>Child conclusions are model claims. Host check receipts record only the commands shown against their artifact digest; acceptance does not certify unrelated tests or independent review.</p>
    {approval.evidence && <code className="block break-all">Transcript: {approval.evidence.sessionID} / {approval.evidence.messageID}</code>}
  </div>;
}

function Application({ approval }: { approval: ApplicationApproval }) {
  return <div className="space-y-2">
    <pre className={BLOCK}>{`Destination: ${approval.directory}\nBaseline head: ${approval.head}\nScoped files:\n${approval.files.join('\n')}`}</pre>
    <pre className={BLOCK}>{`Job: ${approval.jobID}\nApplication digest: ${approval.digest}\nCombined handoff digest: ${approval.handoffDigest}`}</pre>
    <div className="font-medium">Exact combined host diff to apply</div>
    <pre className="typography-code rounded bg-muted/30 p-2 whitespace-pre-wrap break-all max-h-96 overflow-auto">{approval.diff || '(No file changes)'}</pre>
    <div className="font-medium">Combined host check receipts</div>
    {approval.checks.length ? approval.checks.map(check => <CheckReceipt key={check.id} check={check} />)
      : <p>No host check receipts recorded.</p>}
    <p>These receipts verify only the shown commands against the combined handoff digest. They do not certify unrelated tests or independent review.</p>
    <p>Allow once applies this exact combined result to the destination shown. It adds no persistent grant and performs no commit, push or publication.</p>
    <p className="whitespace-pre-wrap">{approval.warning}</p>
  </div>;
}

type ApprovalMode = OperatorWriteApproval['mode'];
type ApprovalViews = { [Mode in ApprovalMode]: {
  title: string;
  render: (approval: Extract<OperatorWriteApproval, { mode: Mode }>) => ReactNode;
} };
const approvalViews: ApprovalViews = {
  'create-write': { title: 'Approve scoped file edits', render: approval => <Creation approval={approval} /> },
  'accept-write': { title: 'Accept completed file edits', render: approval => <Acceptance approval={approval} /> },
  'apply-handoff': { title: 'Apply combined result', render: approval => <Application approval={approval} /> },
};
function approvalDetails<Mode extends ApprovalMode>(mode: Mode, approval: Extract<OperatorWriteApproval, { mode: Mode }>) {
  return approvalViews[mode].render(approval);
}

/** The exact diff remains available by scrolling; host check output has a labeled display bound. */
export function OperatorWriteApprovalView({ approval }: { approval: OperatorWriteApproval }) {
  return <section className="space-y-2 typography-meta" aria-label="Scoped operator write approval">
    <h3 className="font-medium">{approvalViews[approval.mode].title}</h3>
    <div className="font-medium">Original request</div>
    <pre className={BLOCK}>{approval.intake}</pre>
    <div className="font-medium">Goal and constraints</div>
    <pre className={BLOCK}>{[approval.goal, ...approval.constraints].join('\n')}</pre>
    {approvalDetails(approval.mode, approval)}
  </section>;
}
