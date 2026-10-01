import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OPERATOR_WRITE_PERMISSION, type OperatorCheckRecord } from '@onionsoup/owners';
import { operatorWriteApprovalOf } from '../src/operator-write-approval.ts';
import { OperatorWriteApprovalView } from '../web/src/components/OperatorWriteApproval.tsx';
import { PendingCard } from '../web/src/chat/cards.tsx';
import { Decision } from '../web/src/components/Decision.tsx';

function fixture() {
  const handoffDigest = 'a'.repeat(64);
  const check: OperatorCheckRecord = { id: 'check_combined', checkID: 'check_unit', command: ['go', 'test', './...'],
    callID: 'handoff_exact_admission', messageID: 'msg_check', artifactDigest: handoffDigest,
    status: 'completed', startedAt: '2026-10-01T12:00:00.000Z', completedAt: '2026-10-01T12:00:01.000Z',
    exitCode: 0, output: 'ok example.test/calculator 0.004s\n<script>inert output</script>', outputTruncated: false,
    runtime: { kind: 'go', version: 'go1.25.8', binarySha256: 'b'.repeat(64) } };
  check.digest = 'f'.repeat(64);
  const diff = ['diff --git a/calculator.go b/calculator.go', '--- a/calculator.go', '+++ b/calculator.go',
    '@@ -1 +1 @@', '-return oldResult', '+return combinedResult',
    ...Array.from({ length: 180 }, (_, index) => ` context ${index}`), '+final exact combined line'].join('\n');
  const metadata = { mode: 'apply-handoff', approvalScope: 'once', originalIntake: { text: 'Apply the accepted calculator fixes <script>exactly</script>' },
    goal: 'Use the accepted combined calculator behavior', constraints: ['Only the approved paths', 'Preserve the original child worktrees'],
    directory: '/configured/worktrees/review-destination', artifact: { head: 'c'.repeat(40), diff, files: [{ path: 'calculator.go' }] },
    checks: [check], digest: 'd'.repeat(64), handoffDigest, jobID: 'job_combined',
    warning: 'Apply this exact combined result only; no commit/push/publication; interrupted partial writes retain reservation' };
  const permission = { id: 'permission_apply', sessionID: 'ses_parent', permission: OPERATOR_WRITE_PERMISSION,
    patterns: [`apply/job_combined/${metadata.digest}`], metadata, always: [] };
  return { metadata, permission, check };
}

test('apply-handoff parses exact destination, original scope, digests and combined host check provenance', () => {
  const { permission, metadata, check } = fixture();
  const approval = operatorWriteApprovalOf(permission);
  assert(approval);
  assert.equal(approval.mode, 'apply-handoff');
  if (approval.mode !== 'apply-handoff') assert.fail('application metadata must keep its own mode');
  assert.equal(approval.directory, metadata.directory);
  assert.equal(approval.head, metadata.artifact.head);
  assert.equal(approval.goal, metadata.goal);
  assert.equal(approval.intake, metadata.originalIntake.text);
  assert.deepEqual(approval.constraints, metadata.constraints);
  assert.equal(approval.diff, metadata.artifact.diff);
  assert.deepEqual(approval.files, ['calculator.go']);
  assert.equal(approval.digest, metadata.digest);
  assert.equal(approval.handoffDigest, metadata.handoffDigest);
  assert.equal(approval.jobID, metadata.jobID);
  assert.equal(approval.warning, metadata.warning);
  assert.deepEqual(approval.checks, [check]);
});

test('chat and inbox application cards show the full exact result with Allow once and no persistent grant', () => {
  const { permission, metadata, check } = fixture();
  const approval = operatorWriteApprovalOf(permission);
  assert(approval);
  const entry = { kind: 'permission' as const, id: permission.id, owner: 'operator', title: 'Apply combined result',
    detail: '', sessionID: permission.sessionID, permission, operatorWriteApproval: approval };
  const views = [
    renderToStaticMarkup(createElement(PendingCard, { entry, onDone: () => {} })),
    renderToStaticMarkup(createElement(Decision, { entry, onDone: () => {} })),
  ];
  for (const html of views) {
    assert.match(html, /Apply combined result/);
    assert.match(html, /Destination: \/configured\/worktrees\/review-destination/);
    assert.match(html, /Baseline head: c{40}/);
    assert.match(html, /Original request/);
    assert.match(html, /Use the accepted combined calculator behavior/);
    assert.match(html, /Preserve the original child worktrees/);
    assert.match(html, /Exact combined host diff to apply/);
    assert.match(html, /final exact combined line/);
    assert.match(html, /Application digest: d{64}/);
    assert.match(html, /Combined handoff digest: a{64}/);
    assert.match(html, /Job: job_combined/);
    assert.match(html, /Combined host check receipts/);
    assert.match(html, /Receipt: check_combined/);
    assert.match(html, new RegExp(`Receipt digest: ${check.digest}`));
    assert.match(html, /Command: \[&quot;go&quot;,&quot;test&quot;,&quot;\.\/\.\.\.&quot;\]/);
    assert.match(html, /Exit code: 0/);
    assert.match(html, /Runtime: go1\.25\.8/);
    assert.match(html, /does not certify|do not certify/);
    assert.match(html, /Allow [Oo]nce<\/button>/);
    assert.match(html, /Reject|Deny/);
    assert.match(html, /no persistent grant/);
    assert.match(html, /no commit, push or publication/);
    assert.match(html, /interrupted partial writes retain reservation/);
    assert.match(html, /&lt;script&gt;exactly&lt;\/script&gt;/);
    assert.match(html, /&lt;script&gt;inert output&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>|Always/);
    assert.equal(metadata.artifact.diff.endsWith('+final exact combined line'), true);
  }
});

test('malformed application scope and non-successful or mismatched combined check metadata never become an approval view', () => {
  const { permission, metadata, check } = fixture();
  const invalid = [
    { ...metadata, digest: undefined },
    { ...metadata, digest: 'not-a-digest' },
    { ...metadata, handoffDigest: undefined },
    { ...metadata, jobID: '' },
    { ...metadata, warning: undefined },
    { ...metadata, checks: undefined },
    { ...metadata, checks: [{ ...check, exitCode: 1 }] },
    { ...metadata, checks: [{ ...check, status: 'prepared' }] },
    { ...metadata, checks: [{ ...check, artifactDigest: 'e'.repeat(64) }] },
    { ...metadata, checks: [{ ...check, command: ['sh', '-c', 'go test ./...'] }] },
    { ...metadata, mode: 'apply-anything' },
  ];
  for (const candidate of invalid) {
    assert.equal(operatorWriteApprovalOf({ ...permission, metadata: candidate }), undefined);
  }
  assert.equal(operatorWriteApprovalOf({ ...permission, permission: 'edit' }), undefined);
});

test('application scope without configured receipts stays explicit instead of displaying manufactured check success', () => {
  const { permission, metadata } = fixture();
  const approval = operatorWriteApprovalOf({ ...permission, metadata: { ...metadata, checks: [] } });
  assert(approval);
  const html = renderToStaticMarkup(createElement(OperatorWriteApprovalView, { approval }));
  assert.match(html, /No host check receipts recorded/);
  assert.doesNotMatch(html, /Exit code: 0|all tests passed/i);
});
