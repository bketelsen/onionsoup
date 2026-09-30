import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime.ts';
import { git, refreshCheckout } from '../src/workspace.ts';
import { observeExternalMerge } from '../src/external-publication.ts';
import { recordDeskReview } from '../src/desk-reviews.ts';
import { reviewSubject } from '../src/desk-reviews.ts';
import { recordRequestWorkEvidence } from '../src/request-work-evidence.ts';
import { prepareRequestClosure, acceptRequestClosure } from '../src/request-closure.ts';
import { completeAcceptedRequest } from '../src/request-closure-completion.ts';
import type { ClosureReview } from '../src/request-closure-types.ts';
import type { Finding } from '../src/artifacts.ts';

export const originalGoal = {
  title: 'Revalidate stale friction safely', goal: 'Preserve report history and avoid obsolete serialization work',
  rationale: 'A report can outlive its original source',
  acceptance: ['Use effective approval after revalidation', 'Already-fixed work creates no dispatch'], size: 'small' as const,
};
export const findings: Finding[] = [
  { severity: 'major', file: 'friction.mjs', issue: 'Dispatch uses the obsolete digest', suggestion: 'Use the current revision digest' },
  { severity: 'major', file: 'friction.mjs', issue: 'Already-fixed may create obsolete work', suggestion: 'Do not dispatch an already-fixed report' },
  { severity: 'minor', file: 'History.tsx', issue: 'A full historical inspector is missing', suggestion: 'Add a complete historical browser' },
];
export const historicalVerdict = { decision: 'revise' as const, summary: 'Original PR100 head requires follow-up', findings };
export const defectiveSource = `export function dispatch(report) { return { digest: report.originalDigest, request: 'serialize' }; }\n`;
export const fixedSource = `export function dispatch(report) { return report.status === 'already-fixed' ? null : { digest: report.revisionDigest, request: 'serialize' }; }\n`;
const findingId = (finding: Finding) => createHash('sha256').update(JSON.stringify(finding)).digest('hex');
export const approvedReview = (): ClosureReview => ({
  verdict: { decision: 'approve', summary: 'PR107 satisfies the original scoped acceptance criteria', findings: [] },
  resolutions: findings.map((finding, index) => ({ finding: findingId(finding),
    disposition: index === 2 ? 'outside-original-scope' : 'fixed',
    evidence: index === 2 ? 'The original approved plan explicitly excludes a full history inspector.'
      : `The merged follow-up changes friction.mjs and the representative dispatch fixture validates finding ${index + 1}.` })),
});

async function commit(directory: string, message: string) {
  await git(directory, ['add', '.']);
  await git(directory, ['commit', '-qm', message]);
  return (await git(directory, ['rev-parse', 'HEAD'])).trim();
}

async function closureFixture() {
  const root = await mkdtemp(join(tmpdir(), 'onionsoup-closure-'));
  const remote = join(root, 'origin');
  await mkdir(remote);
  await git(remote, ['init', '-q', '--bare', '--initial-branch=main']);
  const source = join(root, 'follow-up');
  await git(root, ['clone', '-q', remote, source]);
  await git(source, ['config', 'user.name', 'Fixture']);
  await git(source, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(source, 'README.md'), 'Isolated PR100/PR107 representative fixture\n');
  const base = await commit(source, 'Original base');
  await writeFile(join(source, 'friction.mjs'), defectiveSource);
  const oldHead = await commit(source, 'PR100 stale friction implementation');
  await git(source, ['push', '-q', 'origin', 'HEAD:main']);
  const original = join(root, 'original-plan');
  await git(source, ['worktree', 'add', '-q', '--detach', original, oldHead]);
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: join(root, 'state') });
  const owner = runtime.owner('clippy');
  runtime.declarations.owners.set('clippy', { ...owner, workspace: join(root, 'checkout'),
    domain: { kind: 'git-repository', name: 'example/clippy', remote, baseBranch: 'main', verify: [] } });
  await refreshCheckout(runtime.repositoryOwner('clippy'));
  await runtime.notebook('clippy').ensure('# Fixture');
  await runtime.notebook('bellonda').ensure('# Fixture');
  const request = await runtime.requests.open('bellonda', 'clippy', { kind: 'work', purpose: originalGoal.goal, proposal: originalGoal }, 'none');
  const item = await runtime.ledger.create('clippy', 'owner-change', originalGoal, {
    status: 'working', request: request.id, planWorktree: original,
    planDocument: { markdown: 'Preserve stale-report history. Fix effective approval and avoid already-fixed dispatch. Full history inspector is out of scope.', digest: 'approved-original-goal' },
    planApproval: { by: 'person', at: '2026-09-30T11:27:00.000Z', note: 'Approved original scoped work' },
    verdicts: [{ decision: 'approve', summary: 'Original independent review', findings: [] }],
    humanNotes: [{ kind: 'approval', by: 'person', at: '2026-09-30T11:27:00.000Z', note: 'Preserve original intent' }],
    reason: 'review_changes_required',
  });
  await runtime.requests.update(request.id, current => ({ ...current, workItem: item.id, status: 'work-running' }));
  const oldTree = (await git(original, ['rev-parse', 'HEAD^{tree}'])).trim();
  const verification = { tree: oldTree, observedAt: new Date().toISOString(), verifier: 'host-sandbox' as const, checks: [] };
  await recordRequestWorkEvidence(runtime, item, { stage: 'reviewed', verification,
    review: { reviewer: 'other-family/historical', verdict: historicalVerdict }, blocker: 'review_changes_required' });
  await recordDeskReview(runtime, 'clippy', reviewSubject('example/clippy', item.id), {
    ...historicalVerdict, reviewer: 'other-family/historical', at: new Date().toISOString(), tree: oldTree, evidence: verification,
  });
  const pull = (number: number, head: string, before: string) => ({
    html_url: `https://github.com/example/clippy/pull/${number}`, state: 'closed', merged: true, draft: false, auto_merge: null,
    head: { ref: `pr-${number}`, sha: head, repo: { full_name: 'example/clippy' } },
    base: { ref: 'main', sha: before, repo: { full_name: 'example/clippy' } },
    merge_commit_sha: head, merged_at: '2026-09-30T13:45:00.000Z',
  });
  const originalPr = pull(100, oldHead, base);
  await writeFile(join(source, 'friction.mjs'), fixedSource);
  const head = await commit(source, 'PR107 effective approval and already-fixed follow-up');
  await git(source, ['push', '-q', 'origin', 'HEAD:main']);
  const followUp = pull(107, head, oldHead);
  const metadata = { '100': originalPr, '107': followUp };
  const metadataPath = join(root, 'github.json');
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst metadata = JSON.parse(fs.readFileSync(${JSON.stringify(metadataPath)}, 'utf8'));\nconst args = process.argv.slice(2);\nif (args[0] !== 'api') throw Error('fixture_only_allows_read_api');\nconst number = args[1].split('/').at(-1);\nconsole.log(JSON.stringify(metadata[number]));\n`, { mode: 0o755 });
  const saveMetadata = () => writeFile(metadataPath, JSON.stringify(metadata));
  await saveMetadata();
  return { runtime, root, source, original, oldHead, head, item, request, originalPr, followUp, metadata, saveMetadata, bin };
}

type Fixture = Awaited<ReturnType<typeof closureFixture>>;
export async function withFixture(operation: (fixture: Fixture) => Promise<void>) {
  const fixture = await closureFixture();
  const previousPath = process.env.PATH;
  process.env.PATH = `${fixture.bin}:${previousPath}`;
  try {
    await observeExternalMerge(fixture.runtime, 'clippy', fixture.item.id, fixture.originalPr.html_url, 'person');
    await operation(fixture);
  } finally {
    process.env.PATH = previousPath;
  }
}

export function scriptReview(fixture: Fixture, answer: () => Promise<ClosureReview> = async () => approvedReview()) {
  fixture.runtime.hire = async (_owner, request) => ({
    value: request.schema.parse(await answer()), sessionID: 'closure-review-fixture', cost: 0,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  });
}
export const prepare = (fixture: Fixture) => prepareRequestClosure(fixture.runtime, 'clippy', fixture.item.id, fixture.source, [fixture.followUp.html_url], 'person');
export async function accept(fixture: Fixture, digest: string) {
  const accepted = await acceptRequestClosure(fixture.runtime, 'clippy', fixture.item.id, digest, 'person', 'I accept the original scoped goal with the verified PR107 follow-up.');
  await completeAcceptedRequest(fixture.runtime, fixture.item.id);
  return accepted;
}
