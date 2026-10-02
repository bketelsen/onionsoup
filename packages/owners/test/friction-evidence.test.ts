import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectIncidentBundle, FRICTION_EVIDENCE_LIMITS } from '../src/friction-evidence.ts';
import { investigateFriction, readFrictionTriage, refreshFriction, ownerFrictionDetail, frictionBacklog,
  nextFrictionInvestigation } from '../src/friction-work.ts';
import { routeConfiguredFrictionProposals, frictionPromotionView } from '../src/friction-promotion.ts';
import { decideWork } from '../src/delegation.ts';
import { reportFriction } from '../src/friction.ts';
import { recordRequestWorkEvidence } from '../src/request-work-evidence.ts';
import { rememberSession } from '../src/session-history.ts';
import { ApiKey } from '../src/providers.ts';
import { recordDutyRun } from '../src/daemon.ts';
import { HireError } from '../src/opencode.ts';
import { frictionFixture } from './friction-fixture.ts';

test('host bundle links ledger/rebase/review/check/effect/session/schedule/authority without raw output or credentials', async () => {
  const state = await frictionFixture();
  try {
    const runtime = state.runtime;
    runtime.declarations.providers = { fixture: { baseURL: 'https://example.invalid', models: { model: {} },
      structuredOutput: true, apiKey: new ApiKey('PRIVATE_DECLARED_VALUE') } };
    const request = await runtime.requests.open('clippy', 'clippy', { kind: 'work', purpose: state.proposal.goal, proposal: state.proposal }, 'none');
    await runtime.requests.save({ ...request, status: 'work-running', workItem: state.item.id });
    await runtime.ledger.update(state.item.id, item => ({ ...item, request: request.id,
      implementations: [{ report: { summary: 'Fixture', filesChanged: [], deviationsFromPlan: [] },
        diffStat: '', verification: [{ command: 'check', exitCode: 1, output: 'PRIVATE_RAW_OUTPUT' }] }] }));
    const linked = await runtime.ledger.get(state.item.id);
    await recordRequestWorkEvidence(runtime, linked, { stage: 'blocked', blocker: 'configured_check_failed',
      verification: { tree: state.first, observedAt: new Date().toISOString(), verifier: 'host-sandbox',
        checks: [{ command: 'PRIVATE_DECLARED_VALUE', exitCode: 1, configurationIndex: 1 }] } });
    const sibling = await runtime.ledger.create('clippy', 'rebase', state.proposal, { status: 'rejected',
      rebaseOf: { itemId: state.item.id, branch: 'fixture', prUrl: linked.publication!.url, previousHead: state.first } });
    await rememberSession(runtime, { id: 'original-session', owner: 'clippy', directory: state.workspace,
      item: state.item.id, title: 'PRIVATE_TRANSCRIPT_TITLE', archived: true, time: { created: 1, updated: 2 } });
    await writeFile(join(state.root, 'providers.yaml'), 'fixture:\n  baseURL: https://example.invalid\n  models: { model: {} }\n  apiKeyFile: secrets/fixture-key\n');
    await writeFile(join(runtime.stateDirectory, 'duties.json'), JSON.stringify({ 'clippy/prs': '2026-01-01T00:00:00.000Z' }));
    const bundle = await collectIncidentBundle(runtime, state.report, state.policy);
    const facts = new Map(bundle.facts.map(fact => [fact.key, fact]));
    assert.equal(facts.get(`item:${sibling.id}`)?.values.status, 'rejected');
    assert.deepEqual(facts.get(`verification:${state.item.id}`)?.values.exitCodes, [1]);
    assert.equal(facts.get('session:original-session')?.values.archived, true);
    assert.deepEqual(facts.get('authority:clippy')?.values.schedules, ['prs:maintain-prs:unscheduled']);
    assert.deepEqual(facts.get('provider-credential-references')?.values.references, ['fixture:secrets/fixture-key']);
    assert.equal(facts.get('source-head')?.status, 'observed');
    assert.equal(facts.get('installed-build')?.status, 'missing');
    const repeated = await collectIncidentBundle(runtime, state.report, state.policy);
    assert.equal(repeated.digest, bundle.digest);
    assert.deepEqual(bundle.facts.map(fact => fact.key), bundle.facts.map(fact => fact.key).sort((left, right) => left.localeCompare(right)));
    assert.doesNotMatch(JSON.stringify(bundle), /PRIVATE_|PRIVATE_TRANSCRIPT|output|apiKey":/);
    assert.ok(Buffer.byteLength(JSON.stringify(bundle)) < FRICTION_EVIDENCE_LIMITS.bundleBytes + 4096);
  } finally { await state.cleanup(); }
});

test('bundle precedes diagnosis; configured promotion is one original gated workflow, not a person assignment', async () => {
  const state = await frictionFixture();
  try {
    let calls = 0;
    state.runtime.hire = async (_owner, request) => {
      calls++;
      if (calls > 1) return { value: request.schema.parse({ decision: 'accept', reply: 'Ordinary owner work' }),
        sessionID: 'acceptance', cost: 0, startedAt: state.report.firstSeen, finishedAt: state.report.firstSeen };
      assert.equal(request.extraPermission?.bash, 'deny');
      assert.match(request.brief, /host-incident-bundle/);
      assert.match(request.brief, /maintain-prs:unscheduled/);
      assert.ok((await readFrictionTriage(state.runtime, state.report.id))?.bundle);
      return { value: request.schema.parse({ disposition: 'propose-fix', observed: ['Host bundle inspected'],
        inferred: [], unknown: [], proposedWork: state.proposal }), sessionID: 'triage', cost: 0,
        startedAt: state.report.firstSeen, finishedAt: state.report.firstSeen };
    };
    await investigateFriction(state.runtime, state.report.id);
    await Promise.all([routeConfiguredFrictionProposals(state.runtime, fail), routeConfiguredFrictionProposals(state.runtime, fail)]);
    const [request] = await state.runtime.requests.list();
    assert.equal(request.ask.kind, 'work');
    if (request.ask.kind === 'work') {
      assert.equal(request.ask.operatorAssignment, undefined);
      assert.equal(request.ask.ownerFollowUp?.id, state.report.id);
    }
    assert.deepEqual(request.approvals, []);
    assert.equal((await frictionPromotionView(state.runtime, state.report.id))?.by, 'owner:clippy');
    await decideWork(state.runtime, request);
    const item = await state.runtime.ledger.get(`w-request-${request.id}`);
    assert.equal(item.status, 'planning');
    assert.equal(item.planApproval, undefined);
    assert.equal(calls, 2);
  } finally { await state.cleanup(); }
});

function fail(_id: string, error: unknown): never { throw error; }

test('unknown operational evidence stays owner-pending; model closure and a merged PR alone prove nothing', async () => {
  const state = await frictionFixture();
  try {
    await state.runtime.ledger.update(state.item.id, item => ({ ...item, publication: { ...item.publication!, state: 'merged' } }));
    state.runtime.hire = async (_owner, request) => ({ value: request.schema.parse({
      disposition: 'already-fixed', fixedBy: state.first, observed: ['check.ts:1 new code exists'],
      inferred: [], unknown: [], conditionEvidence: [`item:${state.item.id}:merged`],
    }), sessionID: 'triage', cost: 0, startedAt: state.report.firstSeen, finishedAt: state.report.firstSeen });
    const outcome = await investigateFriction(state.runtime, state.report.id);
    assert.equal(outcome.state, 'investigated');
    assert.equal('investigation' in outcome && outcome.investigation?.disposition, 'needs-evidence');
    assert.deepEqual(await state.runtime.requests.list(), []);
    assert.equal((await frictionBacklog(state.runtime, 'clippy'))[0]?.id, state.report.id);
    const detail = await ownerFrictionDetail(state.runtime, 'clippy', state.report.id);
    assert.ok(detail.triage?.bundle);
    assert.doesNotMatch(JSON.stringify(detail), /"token"|"runner"/);
    await assert.rejects(ownerFrictionDetail(state.runtime, 'homelab', state.report.id), /friction_not_yours/);
    const folder = join(state.runtime.stateDirectory, 'attention');
    await assert.rejects(readFile(join(folder, 'index.json')), { code: 'ENOENT' });
  } finally { await state.cleanup(); }
});

test('changed evidence cannot replay an uncertain or failed paid diagnosis generation', async () => {
  const state = await frictionFixture();
  try {
    let calls = 0;
    state.runtime.hire = async (_owner, request) => {
      calls++;
      if (calls > 1) throw new Error('provider transport private detail');
      return { value: request.schema.parse({ disposition: 'needs-evidence', observed: ['Host facts'],
        inferred: [], unknown: ['No positive operational condition'] }),
      sessionID: 'initial', cost: 0, startedAt: state.report.firstSeen, finishedAt: state.report.firstSeen };
    };
    await investigateFriction(state.runtime, state.report.id);
    await state.resolveCondition();
    assert.equal((await refreshFriction(state.runtime, state.report.id)).state, 'failed');
    await state.runtime.ledger.update(state.item.id, item => ({ ...item, reason: 'new_safe_host_fact' }));
    assert.equal((await refreshFriction(state.runtime, state.report.id)).state, 'failed');
    assert.equal(calls, 2);
  } finally { await state.cleanup(); }
});

test('ordinary duty, journal and session timestamps do not cause paid re-diagnosis', async () => {
  const state = await frictionFixture();
  try {
    const session = { id: 'original-session', owner: 'clippy', directory: state.workspace,
      item: state.item.id, title: 'Fixture', time: { created: 1, updated: 1 } };
    await rememberSession(state.runtime, session);
    let calls = 0;
    state.runtime.hire = async (_owner, request) => {
      calls++;
      return { value: request.schema.parse({ disposition: 'needs-evidence', observed: ['Original facts'],
        inferred: [], unknown: ['Still missing actual operational condition'] }),
      sessionID: 'initial', cost: 0, startedAt: state.report.firstSeen, finishedAt: state.report.firstSeen };
    };
    await investigateFriction(state.runtime, state.report.id);
    const digest = (await readFrictionTriage(state.runtime, state.report.id))!.bundle!.digest;
    for (let index = 2; index < 4; index++) {
      await recordDutyRun(state.runtime, 'clippy', 'prs');
      await state.runtime.notebook('clippy').journal({ kind: 'note', note: `Unrelated routine event ${index}` });
      await rememberSession(state.runtime, { ...session, time: { ...session.time, updated: index } });
      await state.runtime.ledger.update(state.item.id, item => ({ ...item }));
      assert.equal((await collectIncidentBundle(state.runtime, state.report, state.policy)).digest, digest);
      assert.equal(await nextFrictionInvestigation(state.runtime), undefined);
      assert.equal((await refreshFriction(state.runtime, state.report.id)).state, 'unchanged');
    }
    assert.equal(calls, 1);
  } finally { await state.cleanup(); }
});

test('post-closure recurrence reappears as owner follow-up and becomes a fresh bounded diagnosis generation', async () => {
  const state = await frictionFixture();
  try {
    const condition = await state.resolveCondition();
    let calls = 0;
    state.runtime.hire = async (_owner, request) => {
      calls++;
      return { value: request.schema.parse(calls === 1
        ? { disposition: 'already-fixed', fixedBy: state.first, conditionEvidence: [condition],
          observed: ['Host positive original condition'], inferred: [], unknown: [] }
        : { disposition: 'needs-evidence', observed: ['Recurrence after earlier host closure'],
          inferred: [], unknown: ['New operational postcondition needed'] }),
      sessionID: `diagnosis-${calls}`, cost: 0, startedAt: state.report.firstSeen, finishedAt: state.report.firstSeen };
    };
    await investigateFriction(state.runtime, state.report.id);
    assert.deepEqual(await frictionBacklog(state.runtime, 'clippy'), []);
    await reportFriction(state.runtime, { owner: 'clippy', origin: state.report.origin,
      input: { summary: state.report.summary, expected: state.report.expected, actual: state.report.actual, evidence: state.item.id },
      failures: [], model: state.report.model, commit: state.first, submissionID: 'after-closure' });
    const [pending] = await frictionBacklog(state.runtime, 'clippy');
    assert.equal(pending?.id, state.report.id);
    assert.equal(pending?.disposition, 'needs-evidence');
    assert.equal(pending?.reason, 'friction_condition_recurred');
    assert.equal((await nextFrictionInvestigation(state.runtime))?.id, state.report.id);
    await refreshFriction(state.runtime, state.report.id);
    assert.equal(calls, 2);
    assert.equal((await nextFrictionInvestigation(state.runtime)), undefined);
    assert.deepEqual(await state.runtime.requests.list(), []);
  } finally { await state.cleanup(); }
});

test('host-returned terminal analysis failure recovers only on fresh applicable facts, without human reset', async () => {
  for (const failsInitially of [true, false]) {
    const state = await frictionFixture();
    try {
      let calls = 0;
      state.runtime.hire = async (_owner, request) => {
        calls++;
        if (calls === (failsInitially ? 1 : 2)) {
          throw new HireError('deliverable_invalid: unsafe raw deliverable withheld', 'host-returned', undefined, undefined, 'returned-terminal');
        }
        return { value: request.schema.parse({ disposition: 'needs-evidence', observed: ['Host facts'],
          inferred: [], unknown: ['Still missing live attestation'] }),
        sessionID: `diagnosis-${calls}`, cost: 0, startedAt: state.report.firstSeen, finishedAt: state.report.firstSeen };
      };
      await investigateFriction(state.runtime, state.report.id);
      if (!failsInitially) {
        await state.resolveCondition();
        assert.equal((await refreshFriction(state.runtime, state.report.id)).state, 'failed');
      }
      assert.equal(await nextFrictionInvestigation(state.runtime), undefined);
      const before = calls;
      await state.runtime.ledger.update(state.item.id, item => ({ ...item, reason: 'changed_original_incident_status' }));
      assert.equal((await nextFrictionInvestigation(state.runtime))?.id, state.report.id);
      assert.equal((await refreshFriction(state.runtime, state.report.id)).state, 'done');
      assert.equal(calls, before + 1);
      assert.equal(await nextFrictionInvestigation(state.runtime), undefined);
      assert.doesNotMatch(JSON.stringify(await ownerFrictionDetail(state.runtime, 'clippy', state.report.id)), /unsafe raw deliverable/);
    } finally { await state.cleanup(); }
  }
});

test('a new occurrence during diagnosis invalidates old positive postconditions rather than retiring recurrence', async () => {
  const state = await frictionFixture();
  try {
    await state.resolveCondition();
    state.runtime.hire = async (_owner, request) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      await reportFriction(state.runtime, { owner: 'clippy', origin: state.report.origin,
        input: { summary: state.report.summary, expected: state.report.expected, actual: state.report.actual, evidence: state.item.id },
        failures: [], model: state.report.model, commit: state.first, submissionID: 'recurrence' });
      return { value: request.schema.parse({ disposition: 'already-fixed', observed: ['Old positive host receipt'],
        inferred: [], unknown: [], fixedBy: state.first, conditionEvidence: [`fixture-condition:${state.item.id}`] }),
      sessionID: 'diagnosis', cost: 0, startedAt: state.report.firstSeen, finishedAt: state.report.firstSeen };
    };
    const saved = await investigateFriction(state.runtime, state.report.id);
    assert.equal(saved.state, 'investigated');
    assert.equal('investigation' in saved && saved.investigation?.disposition, 'needs-evidence');
    assert.equal((await frictionBacklog(state.runtime, 'clippy')).length, 1);
  } finally { await state.cleanup(); }
});

test('same-source host changes refresh missing evidence once; exact linked duplicates share diagnosis, distinct symptoms do not', async () => {
  const state = await frictionFixture();
  try {
    let calls = 0;
    state.runtime.hire = async (_owner, request) => {
      calls++;
      const conditionEvidence = calls > 1 ? [`fixture-condition:${state.item.id}`] : undefined;
      return { value: request.schema.parse({ disposition: conditionEvidence ? 'already-fixed' : 'needs-evidence',
        fixedBy: conditionEvidence ? state.first : undefined, conditionEvidence, observed: ['Host facts'],
        inferred: [], unknown: conditionEvidence ? [] : ['Original condition has no positive postcondition'] }),
      sessionID: `triage-${calls}`, cost: 0, startedAt: state.report.firstSeen, finishedAt: state.report.firstSeen };
    };
    await investigateFriction(state.runtime, state.report.id);
    const duplicate = await reportFriction(state.runtime, { owner: 'clippy', origin: { sessionID: 'original-session', directory: '/model-selected-not-read' },
      input: { summary: 'Another title for same source incident', expected: state.report.expected, actual: state.report.actual,
        evidence: state.item.id }, failures: [], model: state.report.model, commit: state.first, submissionID: 'duplicate' });
    await investigateFriction(state.runtime, duplicate.id);
    assert.equal((await readFrictionTriage(state.runtime, duplicate.id))?.duplicateOf, state.report.id);
    assert.equal(calls, 1);
    await state.resolveCondition();
    const refreshed = await refreshFriction(state.runtime, state.report.id);
    assert.equal(refreshed.state, 'done');
    if (refreshed.state === 'done') assert.equal(refreshed.revision?.investigation?.disposition, 'already-fixed');
    await refreshFriction(state.runtime, state.report.id);
    assert.equal(calls, 2);
    const distinct = await reportFriction(state.runtime, { owner: 'clippy', origin: { sessionID: 'other', directory: '/not-read' },
      input: { summary: 'A distinct condition', expected: 'Different healthy outcome', actual: 'Different failure', evidence: state.item.id },
      failures: [], model: state.report.model, commit: state.first, submissionID: 'distinct' });
    await investigateFriction(state.runtime, distinct.id);
    assert.equal((await readFrictionTriage(state.runtime, distinct.id))?.duplicateOf, undefined);
    assert.equal(calls, 3);
  } finally { await state.cleanup(); }
});

test('malformed and oversized records have explicit error reasons; origin prose cannot read arbitrary paths', async () => {
  const state = await frictionFixture();
  try {
    await writeFile(join(state.runtime.ledger.directory, 'malformed.json'), '{ broken');
    await writeFile(join(state.runtime.ledger.directory, 'oversized.json'), 'x'.repeat(FRICTION_EVIDENCE_LIMITS.recordBytes + 1));
    const secrets = join(state.root, 'private.env');
    await writeFile(secrets, 'PASSWORD=PRIVATE_HOST_FILE');
    await mkdir(join(state.runtime.stateDirectory, 'plugin-maintenance'), { recursive: true });
    const bundle = await collectIncidentBundle(state.runtime, { ...state.report,
      origin: { sessionID: 'unobserved', directory: secrets }, evidence: `read ${secrets}` }, state.policy);
    assert.equal(bundle.facts.find(fact => fact.key === 'ledger:malformed.json')?.reason, 'invalid_record');
    assert.equal(bundle.facts.find(fact => fact.key === 'ledger:oversized.json')?.status, 'error');
    assert.doesNotMatch(JSON.stringify(bundle), /PRIVATE_HOST_FILE|PASSWORD=/);
  } finally { await state.cleanup(); }
});

test('repeated owner-abandoned rebase reports source-link one actual PR/head incident despite different prose counts', async () => {
  const state = await frictionFixture();
  try {
    for (let index = 0; index < 3; index++) await state.runtime.ledger.create('clippy', 'rebase', state.proposal, {
      status: 'rejected', reason: 'owner_abandoned: original intent no longer wanted',
      rebaseOf: { itemId: state.item.id, prUrl: state.item.publication!.url, branch: 'fixture', previousHead: state.first },
    });

    let calls = 0;
    state.runtime.hire = async (_owner, request) => {
      calls++;
      return { value: request.schema.parse({ disposition: 'needs-evidence', observed: ['Four host rejection records'],
        inferred: [], unknown: ['Operational fix needs positive evidence'] }),
      sessionID: 'diagnosis', cost: 0, startedAt: state.report.firstSeen, finishedAt: state.report.firstSeen };
    };
    await investigateFriction(state.runtime, state.report.id);
    await state.runtime.ledger.create('clippy', 'rebase', state.proposal, {
      status: 'rejected', reason: 'owner_abandoned: original intent no longer wanted',
      rebaseOf: { itemId: state.item.id, prUrl: state.item.publication!.url, branch: 'fixture', previousHead: state.first },
    });
    const duplicate = await reportFriction(state.runtime, { owner: 'clippy',
      origin: { sessionID: 'original-session', directory: state.workspace },
      input: { summary: state.report.summary, expected: state.report.expected,
        actual: 'A fourth rejection occurred after the earlier three', evidence: state.item.id },
      failures: [], model: state.report.model, commit: state.first, submissionID: 'fourth-count' });
    await investigateFriction(state.runtime, duplicate.id);
    const saved = await readFrictionTriage(state.runtime, duplicate.id);
    assert.equal(saved?.duplicateOf, state.report.id);
    assert.equal(saved?.investigation, undefined, 'linkage is not a fabricated model closure');
    assert.equal(calls, 1);
    assert.deepEqual(await state.runtime.requests.list(), []);
    assert.equal((await state.runtime.ledger.get(state.item.id)).publication?.state, 'open');
  } finally { await state.cleanup(); }
});

test('linked condition receipts survive routine journal tails and day rollover without re-diagnosis', async () => {
      const state = await frictionFixture();
      try {
        let calls = 0;
        state.runtime.hire = async (_owner, request) => {
          calls++;
          return { value: request.schema.parse({ disposition: 'needs-evidence', observed: ['Condition facts recorded'],
            inferred: [], unknown: ['Still awaiting another actual operational observation'] }),
          sessionID: 'diagnosis', cost: 0, startedAt: state.report.firstSeen, finishedAt: state.report.firstSeen };
        };
        await investigateFriction(state.runtime, state.report.id);
        await state.resolveCondition();
        await refreshFriction(state.runtime, state.report.id);
        const before = await collectIncidentBundle(state.runtime, state.report, state.policy);
        assert.equal(before.conditions.length, 1);
        for (let index = 0; index < 20; index++) await state.runtime.notebook('clippy').journal({
          kind: 'note', note: `Unrelated routine event ${index}`,
        });
        const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
        await writeFile(join(state.runtime.notebook('clippy').directory, 'journal', `${tomorrow.slice(0, 10)}.jsonl`),
          JSON.stringify({ kind: 'note', at: tomorrow, note: 'Unrelated next-day event' }) + '\n');
        const after = await collectIncidentBundle(state.runtime, state.report, state.policy);
        assert.deepEqual(after.conditions, before.conditions);
        assert.equal(after.digest, before.digest);
        assert.equal(await nextFrictionInvestigation(state.runtime), undefined);
        assert.equal((await refreshFriction(state.runtime, state.report.id)).state, 'unchanged');
        assert.equal(calls, 2);
      } finally { await state.cleanup(); }
    });

    test('busy journal activity during diagnosis cannot erase applicable positive closure receipts', async () => {
      const state = await frictionFixture();
      try {
        const condition = await state.resolveCondition();
        state.runtime.hire = async (_owner, request) => {
          for (let index = 0; index < 20; index++) await state.runtime.notebook('clippy').journal({
            kind: 'note', note: `Unrelated activity while diagnosis runs ${index}`,
          });
          return { value: request.schema.parse({ disposition: 'already-fixed', fixedBy: state.first,
            conditionEvidence: [condition], observed: ['Applicable positive host condition'], inferred: [], unknown: [] }),
          sessionID: 'diagnosis', cost: 0, startedAt: state.report.firstSeen, finishedAt: state.report.firstSeen };
        };
        const saved = await investigateFriction(state.runtime, state.report.id);
        assert.equal(saved.state, 'investigated');
        assert.equal('investigation' in saved && saved.investigation?.disposition, 'already-fixed');
        assert.deepEqual(await frictionBacklog(state.runtime, 'clippy'), []);
      } finally { await state.cleanup(); }
    });

    test('duplicate recurrence after canonical closure reenters owner follow-up instead of staying hidden', async () => {
      const state = await frictionFixture();
      try {
        let calls = 0;
        state.runtime.hire = async (_owner, request) => {
          calls++;
          return { value: request.schema.parse(calls === 2
            ? { disposition: 'already-fixed', fixedBy: state.first, conditionEvidence: [`fixture-condition:${state.item.id}`],
              observed: ['Positive host condition'], inferred: [], unknown: [] }
            : { disposition: 'needs-evidence', observed: ['Current original incident facts'], inferred: [], unknown: ['Operational proof needed'] }),
          sessionID: `diagnosis-${calls}`, cost: 0, startedAt: state.report.firstSeen, finishedAt: state.report.firstSeen };
        };
        await investigateFriction(state.runtime, state.report.id);
        const submission = { owner: 'clippy', origin: state.report.origin,
          input: { summary: 'Another title for same source incident', expected: state.report.expected,
            actual: state.report.actual, evidence: state.item.id }, failures: [], model: state.report.model, commit: state.first };
        const duplicate = await reportFriction(state.runtime, { ...submission, submissionID: 'first-duplicate' });
        await investigateFriction(state.runtime, duplicate.id);
        assert.equal((await readFrictionTriage(state.runtime, duplicate.id))?.duplicateOf, state.report.id);
        await state.resolveCondition();
        await refreshFriction(state.runtime, state.report.id);
        assert.deepEqual(await frictionBacklog(state.runtime, 'clippy'), []);
        await reportFriction(state.runtime, { ...submission, submissionID: 'duplicate-recurrence' });
        const [pending] = await frictionBacklog(state.runtime, 'clippy');
        assert.equal(pending?.id, duplicate.id);
        assert.equal(pending?.reason, 'friction_condition_recurred');
        assert.equal((await nextFrictionInvestigation(state.runtime))?.id, duplicate.id);
        await refreshFriction(state.runtime, duplicate.id);
        assert.equal(calls, 3);
        const detail = await ownerFrictionDetail(state.runtime, 'clippy', duplicate.id);
        assert.equal(detail.triage?.duplicateOf, undefined);
        assert.equal(detail.triage?.investigation?.disposition, 'needs-evidence');
        assert.equal(await nextFrictionInvestigation(state.runtime), undefined);
      } finally { await state.cleanup(); }
    });

    test('recurring duplicates of a still-unresolved source relink without hiring or fabricating findings', async () => {
      const state = await frictionFixture();
      try {
        let calls = 0;
        state.runtime.hire = async (_owner, request) => {
          calls++;
          return { value: request.schema.parse({ disposition: 'needs-evidence', observed: ['Original incident'],
            inferred: [], unknown: ['Operational proof needed'] }),
          sessionID: 'initial', cost: 0, startedAt: state.report.firstSeen, finishedAt: state.report.firstSeen };
        };
        await investigateFriction(state.runtime, state.report.id);
        const submission = { owner: 'clippy', origin: state.report.origin,
          input: { summary: 'Duplicate title', expected: state.report.expected, actual: state.report.actual, evidence: state.item.id },
          failures: [], model: state.report.model, commit: state.first };
        const duplicate = await reportFriction(state.runtime, { ...submission, submissionID: 'duplicate-first' });
        await investigateFriction(state.runtime, duplicate.id);
        await reportFriction(state.runtime, { ...submission, submissionID: 'duplicate-recurrence' });
        const refreshed = await refreshFriction(state.runtime, duplicate.id);
        assert.equal(refreshed.state, 'done');
        if (refreshed.state === 'done') {
          assert.equal(refreshed.revision?.duplicateOf, state.report.id);
          assert.equal(refreshed.revision?.investigation, undefined);
        }
        assert.equal(calls, 1);
        assert.equal((await frictionBacklog(state.runtime, 'clippy')).length, 1);
      } finally { await state.cleanup(); }
    });
