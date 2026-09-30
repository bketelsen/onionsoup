import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { git } from '../src/workspace.ts';
import { deskReviewRounds, recordDeskReview, reviewSubject } from '../src/desk-reviews.ts';
import { readRequestWorkEvidence } from '../src/request-work-evidence.ts';
import { prepareRequestClosure, acceptRequestClosure } from '../src/request-closure.ts';
import { trackDelegatedWork } from '../src/delegation.ts';
import { completeAcceptedRequest } from '../src/request-closure-completion.ts';
import { requestProgressDetail } from '../src/request-status.ts';
import { withFixture, scriptReview, prepare, accept, originalGoal, findings, historicalVerdict, defectiveSource, fixedSource, approvedReview } from './request-closure-fixture.ts';

const run = promisify(execFile);

test('closure prepares PR100 plus PR107 evidence, then explicit acceptance closes once without rewriting historical intent or review', async () => {
  await withFixture(async fixture => {
    const { runtime, item, request, source, original } = fixture;
    const before = await runtime.ledger.get(item.id);
    const oldEvidence = await readRequestWorkEvidence(runtime, before);
    const oldReviews = await deskReviewRounds(runtime, 'clippy', reviewSubject('example/clippy', item.id));
    const behavior = `import {dispatch} from './friction.mjs'; console.log(JSON.stringify([dispatch({status:'already-fixed',originalDigest:'old',revisionDigest:'new'}),dispatch({status:'actionable',originalDigest:'old',revisionDigest:'new'})]));`;
    assert.deepEqual(JSON.parse((await run(process.execPath, ['--input-type=module', '-e', behavior], { cwd: source })).stdout), [null, { digest: 'new', request: 'serialize' }]);
    assert.deepEqual(JSON.parse((await run(process.execPath, ['--input-type=module', '-e', behavior], { cwd: original })).stdout), [{ digest: 'old', request: 'serialize' }, { digest: 'old', request: 'serialize' }]);
    let reviews = 0;
    runtime.hire = async (_owner, hired) => {
      reviews++;
      assert.match(hired.brief, /Preserve report history and avoid obsolete serialization work/);
      assert.match(hired.brief, /approved-original-goal/);
      for (const finding of findings) assert.ok(hired.brief.includes(finding.issue));
      assert.ok(hired.brief.includes('revisionDigest'));
      assert.ok(hired.brief.includes('already-fixed'));
      assert.equal(await readFile(join(source, 'friction.mjs'), 'utf8'), fixedSource);
      return { value: hired.schema.parse(approvedReview()), sessionID: 'closure-review-fixture', cost: 0,
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    };
    const candidate = await prepare(fixture);
    assert.equal(candidate.head, fixture.head);
    assert.equal(candidate.historicalMerges[0]!.head, fixture.oldHead);
    assert.equal(candidate.followUps[0]!.head, fixture.head);
    assert.equal(candidate.review.verdict.decision, 'approve');
    assert.equal(candidate.originalFindings.length, 3);
    assert.equal((await runtime.requests.get(request.id)).status, 'work-running', 'preparing evidence does not accept');
    assert.equal((await runtime.ledger.get(item.id)).status, 'working');
    const accepted = await accept(fixture, candidate.digest);
    assert.equal(accepted.status, 'landed');
    assert.equal(accepted.requestAcceptance!.candidate.digest, candidate.digest);
    assert.equal((await runtime.requests.get(request.id)).status, 'completed');
    const replay = await accept(fixture, candidate.digest);
    assert.deepEqual(replay, accepted);
    const completed = await runtime.requests.get(request.id);
    assert.deepEqual(await trackDelegatedWork(runtime, completed), completed);
    assert.deepEqual(await trackDelegatedWork(runtime, await runtime.requests.get(request.id)), completed);
    assert.deepEqual(await trackDelegatedWork(runtime, { ...completed, status: 'work-running' }), completed, 'a stale daemon snapshot cannot rewind closure');
    assert.match(await requestProgressDetail(runtime, 'bellonda', request.id), /accepted/);
    assert.match(await requestProgressDetail(runtime, 'bellonda', request.id), /revise/);
    assert.equal(reviews, 1);
    for (const field of ['proposal', 'planDocument', 'planApproval', 'verdicts', 'humanNotes', 'implementations', 'externalPrObservations'] as const) {
      assert.deepEqual(accepted[field], before[field], `${field} stays historical`);
    }
    assert.equal(accepted.publication, undefined, 'acceptance is not a fabricated publication');
    assert.equal(accepted.externalPrObservations![0]!.followUpEvidence!.review!.verdict.decision, 'revise');
    assert.deepEqual(await readRequestWorkEvidence(runtime, before), oldEvidence);
    assert.deepEqual(await deskReviewRounds(runtime, 'clippy', reviewSubject('example/clippy', item.id)), oldReviews);
    assert.equal((await git(original, ['rev-parse', 'HEAD'])).trim(), fixture.oldHead);
    assert.equal((await runtime.requests.list()).length, 1);
    assert.equal((await runtime.ledger.list()).length, 1);
  });
});

test('closure rejects absent human authority, wrong ownership, foreign repositories and unmerged follow-ups', async () => {
  await withFixture(async fixture => {
    const { runtime, item, source, followUp } = fixture;
    scriptReview(fixture);
    await assert.rejects(prepareRequestClosure(runtime, 'clippy', item.id, source, [followUp.html_url], ''), /authority|actor|person|human|by/);
    await assert.rejects(prepareRequestClosure(runtime, 'bellonda', item.id, source, [followUp.html_url], 'person'), /item_not_yours|owner/);
    await assert.rejects(prepareRequestClosure(runtime, 'clippy', item.id, source, ['https://github.com/foreign/repo/pull/107'], 'person'), /repository/);
    await assert.rejects(prepareRequestClosure(runtime, 'clippy', item.id, source, [], 'person'), /follow/);
    const declaredOwner = runtime.declarations.owners.get('clippy')!;
    runtime.declarations.owners.set('clippy', { ...declaredOwner, persona: undefined });
    await assert.rejects(prepare(fixture), /owner_cannot_change/);
    runtime.declarations.owners.set('clippy', declaredOwner);
    followUp.merged = false;
    followUp.state = 'open';
    followUp.merge_commit_sha = '';
    await fixture.saveMetadata();
    await assert.rejects(prepare(fixture), /merged|merge/);
    assert.equal((await runtime.ledger.get(item.id)).requestAcceptance, undefined);
    assert.equal((await runtime.requests.get(fixture.request.id)).status, 'work-running');
  });
});

test('repeated and concurrent preparation retain one durable candidate without duplicate lifecycle effects', async () => {
  await withFixture(async fixture => {
    let reviews = 0;
    scriptReview(fixture, async () => { reviews++; return approvedReview(); });
    const [left, right] = await Promise.all([prepare(fixture), prepare(fixture)]);
    assert.equal(left.digest, right.digest);
    const afterRacingReview = reviews;
    assert.equal((await prepare(fixture)).digest, left.digest);
    assert.equal(reviews, afterRacingReview, 'repeated prepare reuses still-current host evidence');
    assert.equal((await fixture.runtime.ledger.get(fixture.item.id)).requestClosureCandidates!.length, 1);
    assert.equal((await fixture.runtime.requests.get(fixture.request.id)).status, 'work-running');
  });
});

test('closure evidence expires without accepting, and changed historical review invalidates a candidate', async context => {
  await withFixture(async fixture => {
    fixture.runtime.repositoryOwner('clippy').domain.requestClosureEvidenceMaxAgeMs = 60_000;
    scriptReview(fixture);
    const candidate = await prepare(fixture);
    const originalNow = Date.now;
    context.mock.method(Date, 'now', () => Date.parse(candidate.verification.observedAt) + 60_001);
    await assert.rejects(accept(fixture, candidate.digest), /evidence_expired/);
    context.mock.restoreAll();
    assert.equal(Date.now, originalNow);
    await recordDeskReview(fixture.runtime, 'clippy', reviewSubject('example/clippy', fixture.item.id), {
      at: new Date().toISOString(), reviewer: 'other-family/historical', tree: candidate.tree,
      decision: 'revise', summary: 'Later original-item finding', findings: [{ ...findings[0]!, issue: 'New finding after preparation' }],
    });
    await assert.rejects(accept(fixture, candidate.digest), /changed|stale/);
    assert.equal((await fixture.runtime.requests.get(fixture.request.id)).status, 'work-running');
  });
});

test('later cancellation or approved-plan revision wins over prepared closure', async () => {
  await withFixture(async fixture => {
    scriptReview(fixture);
    const candidate = await prepare(fixture);
    const { runtime, item } = fixture;
    await runtime.ledger.update(item.id, current => ({ ...current, status: 'cancelled' }));
    await assert.rejects(accept(fixture, candidate.digest), /not_working|changed/);
    await runtime.ledger.update(item.id, current => ({ ...current, status: 'working',
      planDocument: { ...current.planDocument!, digest: 'new-approved-plan' } }));
    await assert.rejects(accept(fixture, candidate.digest), /changed|mismatch|stale/);
    assert.equal((await runtime.ledger.get(item.id)).requestAcceptance, undefined);
    assert.equal((await runtime.ledger.get(item.id)).planDocument!.digest, 'new-approved-plan');
  });
});

test('closure requires every historical finding to be explicitly reviewed and rejects a current revise verdict', async () => {
  await withFixture(async fixture => {
    scriptReview(fixture, async () => ({ ...approvedReview(), resolutions: approvedReview().resolutions.slice(0, 1) }));
    await assert.rejects(prepare(fixture), /resolution|finding/);
    scriptReview(fixture, async () => ({ ...approvedReview(), resolutions: [...approvedReview().resolutions, approvedReview().resolutions[0]!] }));
    await assert.rejects(prepare(fixture), /resolution|finding/);
    scriptReview(fixture, async () => ({ ...approvedReview(), verdict: { ...historicalVerdict,
      findings: [{ ...findings[0]!, severity: 'blocker' }] } }));
    await assert.rejects(prepare(fixture), /review|revise/);
    scriptReview(fixture, async () => ({ ...approvedReview(), verdict: { ...historicalVerdict,
      findings: [{ ...findings[0]!, severity: 'minor' }] } }));
    await assert.rejects(prepare(fixture), /review|revise/);
    assert.equal((await fixture.runtime.ledger.get(fixture.item.id)).requestAcceptance, undefined);
    assert.equal((await fixture.runtime.requests.get(fixture.request.id)).status, 'work-running');
  });
});

test('closure acceptance rejects another digest, missing note and missing actor without consuming prepared evidence', async () => {
  await withFixture(async fixture => {
    scriptReview(fixture);
    const candidate = await prepare(fixture);
    const { runtime, item } = fixture;
    await assert.rejects(accept(fixture, 'f'.repeat(64)), /digest|candidate/);
    await assert.rejects(acceptRequestClosure(runtime, 'clippy', item.id, candidate.digest, '', 'Accept'), /authority|actor|person|human|by/);
    await assert.rejects(acceptRequestClosure(runtime, 'clippy', item.id, candidate.digest, 'person', ''), /note|accept/);
    assert.equal((await runtime.ledger.get(item.id)).requestAcceptance, undefined);
    assert.equal((await accept(fixture, candidate.digest)).status, 'landed');
  });
});

test('closure acceptance rejects source drift and changed remote merge evidence', async () => {
  await withFixture(async fixture => {
    scriptReview(fixture);
    const candidate = await prepare(fixture);
    await writeFile(join(fixture.source, 'friction.mjs'), defectiveSource);
    await assert.rejects(accept(fixture, candidate.digest), /source|dirty|stale|changed/);
    await git(fixture.source, ['checkout', '--', 'friction.mjs']);
    const merge = fixture.followUp.merge_commit_sha;
    fixture.followUp.merge_commit_sha = fixture.oldHead;
    await fixture.saveMetadata();
    await assert.rejects(accept(fixture, candidate.digest), /changed|stale|merge/);
    fixture.followUp.merge_commit_sha = merge;
    await fixture.saveMetadata();
    assert.equal((await accept(fixture, candidate.digest)).status, 'landed');
  });
});

test('closure evidence is bound to the original goal, request and configured verification', async () => {
  await withFixture(async fixture => {
    scriptReview(fixture);
    const candidate = await prepare(fixture);
    const { runtime, item, request } = fixture;
    await runtime.ledger.update(item.id, current => ({ ...current, proposal: { ...current.proposal, goal: 'A different goal' } }));
    await assert.rejects(accept(fixture, candidate.digest), /changed|mismatch|stale/);
    await runtime.ledger.update(item.id, current => ({ ...current, proposal: originalGoal }));
    const originalRequest = await runtime.requests.get(request.id);
    await runtime.requests.update(request.id, current => ({ ...current, ask: { ...current.ask, purpose: 'A different request purpose' } }));
    await assert.rejects(accept(fixture, candidate.digest), /changed|mismatch|stale/);
    await runtime.requests.save(originalRequest);
    runtime.repositoryOwner('clippy').domain.verify.push(['false']);
    await assert.rejects(accept(fixture, candidate.digest), /configuration|changed|stale/);
    runtime.repositoryOwner('clippy').domain.verify.pop();
    assert.equal((await accept(fixture, candidate.digest)).status, 'landed');
  });
});

test('closure review runs outside the final locks and refuses a later genuine work mutation', async () => {
  await withFixture(async fixture => {
    const { runtime, item } = fixture;
    scriptReview(fixture, async () => {
      await runtime.ledger.update(item.id, current => ({ ...current, activeRunner: 424242 }));
      return approvedReview();
    });
    await assert.rejects(prepare(fixture), /active|changed|stale/);
    assert.equal((await runtime.ledger.get(item.id)).activeRunner, 424242);
    assert.equal((await runtime.ledger.get(item.id)).requestAcceptance, undefined);
  });
});

test('concurrent acceptance creates one receipt and preserves exact replay state', async () => {
  await withFixture(async fixture => {
    scriptReview(fixture);
    const candidate = await prepare(fixture);
    const [left, right] = await Promise.all([accept(fixture, candidate.digest), accept(fixture, candidate.digest)]);
    assert.deepEqual(left.requestAcceptance, right.requestAcceptance);
    assert.deepEqual(await accept(fixture, candidate.digest), await fixture.runtime.ledger.get(fixture.item.id));
    assert.equal((await fixture.runtime.requests.get(fixture.request.id)).status, 'completed');
  });
});

test('completion projection rejects a changed request and repairs an interrupted projection without another acceptance', async () => {
  await withFixture(async fixture => {
    scriptReview(fixture);
    const candidate = await prepare(fixture);
    const { runtime, request, item } = fixture;
    const accepted = await acceptRequestClosure(runtime, 'clippy', item.id, candidate.digest, 'person', 'Accept verified original scoped goal');
    assert.equal((await runtime.requests.get(request.id)).status, 'work-running', 'simulated process loss after durable receipt, before projection');
    await runtime.ledger.update(item.id, current => ({ ...current, proposal: { ...current.proposal, goal: 'Different goal after acceptance' } }));
    await assert.rejects(completeAcceptedRequest(runtime, item.id), /binding|mismatch|changed/);
    assert.equal((await runtime.requests.get(request.id)).status, 'work-running');
    await runtime.ledger.update(item.id, current => ({ ...current, proposal: originalGoal }));
    assert.equal((await completeAcceptedRequest(runtime, item.id)).status, 'completed');
    assert.deepEqual((await runtime.ledger.get(item.id)).requestAcceptance, accepted.requestAcceptance);
    await runtime.requests.update(request.id, current => ({ ...current, status: 'work-running', workItem: 'another-real-item' }));
    await assert.rejects(completeAcceptedRequest(runtime, item.id), /request_changed/);
    assert.equal((await runtime.requests.get(request.id)).workItem, 'another-real-item');
    assert.equal((await runtime.requests.get(request.id)).status, 'work-running');
  });
});
