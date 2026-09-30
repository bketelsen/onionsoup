import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { processRequest } from '../src/brokering.ts';
import { requestWork } from '../src/delegation.ts';
import { getDirectRequestReview, reviewDirectRequestPlan } from '../src/direct-request-plan-review.ts';
import { deliverPlanRevisions, planRevisionStatus, type PlanRevisionClient } from '../src/plan-revision.ts';
import { submitPlan } from '../src/plan-work.ts';
import { Runtime } from '../src/runtime.ts';
import { SUPERVISION_LIMITS } from '../src/plan-review-limits.ts';
import { approvePlan, cancelItem, revisePlan } from '../src/work-recovery.ts';

const origin = { sessionID: 'fixture-odrade', directory: '/fixture/odrade' };
const planningOrigin = { sessionID: 'fixture-lucilla', directory: '/fixture/lucilla' };
const proposal = {
  title: 'Refresh the README for end users', repository: 'frostyard/updex', size: 'small' as const,
  goal: 'Explain what updex is, how to install it and everyday use in a simple README.',
  rationale: 'Documentation only; no product code, releases or changes to the existing PR.',
  acceptance: ['Only documentation changes', 'Commands match CLI help', 'Finish with a draft PR; do not merge'],
};
const planGoal = 'A short user guide with developer details moved to linked reference documentation.';
const matchedPlan = 'Rewrite README and move developer detail to docs/reference.md. Only Markdown changes. Check links and CLI help. Publish a draft PR, never merge.';

async function setup(context: TestContext, plan = matchedPlan) {
  const root = await mkdtemp(join(tmpdir(), 'direct-plan-review-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const declarations = join(root, 'config');
  await cp('packages/owners/test/fixtures/owners', declarations, { recursive: true });
  const lucillaPath = join(declarations, 'owners/lucilla.yaml');
  const template = await readFile(join(declarations, 'owners/clippy.yaml'), 'utf8');
  await writeFile(lucillaPath, template.replaceAll('example/clippy', 'frostyard/updex').replaceAll('clippy', 'lucilla'));
  await cp(join(declarations, 'charters/clippy.md'), join(declarations, 'charters/lucilla.md'));
  const runtime = await Runtime.open({ declarations, state: join(root, 'state') });
  for (const owner of ['odrade', 'lucilla']) await runtime.notebook(owner).ensure('# Synthetic test charter');
  runtime.hire = async () => { throw new Error('unexpected_model_execution'); };
  const request = await requestWork(runtime, 'odrade', 'lucilla', proposal, undefined, origin);
  await processRequest(runtime, request.id);
  const accepted = await runtime.requests.get(request.id);
  const item = await submitPlan(runtime, 'lucilla', {
    item: accepted.workItem!, repository: proposal.repository, title: proposal.title, goal: planGoal, plan,
  }, planningOrigin);
  return { runtime, request: accepted, item: await runtime.ledger.get(item.id), lucillaPath, declarations };
}

async function approval(runtime: Runtime, request: string) {
  const review = await getDirectRequestReview(runtime, request);
  return {
    request, item: review.item.id, digest: review.digest,
    decision: 'approve' as const, scope: 'matched' as const,
    note: 'The exact plan preserves the requested documentation-only scope and draft-only publication.',
  };
}

async function revoke(path: string) {
  const declaration = await readFile(path, 'utf8');
  await writeFile(path, declaration.replace(/grants:[\s\S]*$/, 'grants: []\n'));
}

async function journal(runtime: Runtime, owner: string) {
  const directory = join(runtime.notebook(owner).directory, 'journal');
  const files = (await readdir(directory)).filter(file => file.endsWith('.jsonl'));
  return (await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')))).join('\n');
}

function holdMutation(runtime: Runtime) {
  const update = runtime.ledger.updateIfChanged.bind(runtime.ledger);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  runtime.ledger.updateIfChanged = async (...args) => {
    runtime.ledger.updateIfChanged = update;
    entered();
    await gate;
    return update(...args);
  };
  return { started, release };
}

test('direct requester uses only its existing grant, preserves both goals and records one exact approval across restart', async context => {
  const { runtime, request, item, declarations } = await setup(context);
  const review = await getDirectRequestReview(runtime, request.id);
  assert.equal(review.reviewer, 'odrade');
  assert.equal(review.repository, proposal.repository);
  assert.equal(review.item.assignment, undefined, 'the real regression is a direct request, not an initiative');
  assert.notEqual(review.item.proposal.goal, request.ask.kind === 'work' && request.ask.proposal.goal);
  const input = await approval(runtime, request.id);
  const approved = await reviewDirectRequestPlan(runtime, 'odrade', input);
  assert.equal(approved.status, 'working');
  assert.match(approved.planApproval!.by, /odrade/);
  assert.equal(approved.directRequestPlanReviews.length, 1);
  assert.equal(approved.directRequestPlanReviews[0]?.digest, input.digest);
  assert.equal(approved.directRequestPlanReviews[0]?.grantTarget, proposal.repository);
  assert.deepEqual((await runtime.requests.get(request.id)).ask, request.ask);
  assert.deepEqual(approved.proposal, item.proposal);
  const reopened = await Runtime.open({ declarations, state: runtime.stateDirectory });
  assert.deepEqual(await reviewDirectRequestPlan(reopened, 'odrade', input), await runtime.ledger.get(item.id), 'retry preserves the exact approval and timestamps');
  assert.equal((await reopened.ledger.list()).length, 1);
  assert.equal((await reopened.requests.list()).length, 1);
  assert.equal(approved.session, undefined, 'review only opens the existing execution gate');
  assert.equal(approved.planWorktree, undefined);
  assert.match(await journal(runtime, 'odrade'), /grant-used/);
  assert.match(await journal(runtime, 'odrade'), new RegExp(input.digest));
});

test('unresolved Go contract-test scope stays with the person and never authorizes execution', async context => {
  const scopePlan = `${matchedPlan}\nAlso repoint two Go README contract tests to the moved documents. The approver must decide whether these test edits fit documentation-only scope; otherwise retain the pinned README sections.`;
  const { runtime, request, item } = await setup(context, scopePlan);
  const input = await approval(runtime, request.id);
  await assert.rejects(reviewDirectRequestPlan(runtime, 'odrade', { ...input, scope: 'needs-human' }), /direct_plan_review_scope_unresolved/);
  const decision = { ...input, decision: 'needs-human' as const, scope: 'needs-human' as const,
    note: 'The request permits documentation only; two Go contract-test edits need the person to decide.' };
  const held = await reviewDirectRequestPlan(runtime, 'odrade', decision);
  assert.equal(held.status, 'awaiting-plan-approval');
  assert.equal(held.planApproval, undefined);
  assert.equal(held.directRequestPlanReviews.length, 1);
  assert.equal(held.directRequestPlanReviews[0]?.decision, 'needs-human');
  assert.deepEqual(await reviewDirectRequestPlan(runtime, 'odrade', decision), held);
  await assert.rejects(reviewDirectRequestPlan(runtime, 'odrade', input), /direct_plan_review_already_decided/);
  const human = await approvePlan(runtime, item.id, 'person', 'Allow only the two documentation-contract path updates; keep draft-only publication.');
  assert.equal(human.planApproval?.by, 'person');
  assert.deepEqual(human.directRequestPlanReviews, held.directRequestPlanReviews, 'the human decision preserves the manager scope concern');
});

test('two concurrent exact reviews persist one approval and one receipt', async context => {
  const { runtime, request } = await setup(context);
  const input = await approval(runtime, request.id);
  const outcomes = await Promise.all([
    reviewDirectRequestPlan(runtime, 'odrade', input), reviewDirectRequestPlan(runtime, 'odrade', input),
  ]);
  assert.deepEqual(outcomes[0].planApproval, outcomes[1].planApproval);
  assert.equal(outcomes[0].updatedAt, outcomes[1].updatedAt);
  const current = await runtime.ledger.get(input.item);
  assert.equal(current.directRequestPlanReviews.length, 1);
  assert.equal(current.humanNotes.filter(note => note.kind === 'approval').length, 1);
});

test('revocation is read from disk even when the runtime still remembers the grant', async context => {
  const { runtime, request, lucillaPath, item } = await setup(context);
  const input = await approval(runtime, request.id);
  assert.ok(runtime.owner('lucilla').grants.length);
  await revoke(lucillaPath);
  await assert.rejects(getDirectRequestReview(runtime, request.id), /direct_plan_review_no_grant/);
  await assert.rejects(reviewDirectRequestPlan(runtime, 'odrade', input), /direct_plan_review_no_grant/);
  assert.deepEqual(await runtime.ledger.get(item.id), item);
});

test('an unrelated repository grant and a different reviewer cannot authorize the direct request', async context => {
  const { runtime, request, lucillaPath, item } = await setup(context);
  const input = await approval(runtime, request.id);
  await assert.rejects(reviewDirectRequestPlan(runtime, 'bellonda', input), /direct_plan_review_not_requester/);
  await writeFile(lucillaPath, (await readFile(lucillaPath, 'utf8')).replace('target: frostyard/updex', 'target: example/wiki'));
  await assert.rejects(reviewDirectRequestPlan(runtime, 'odrade', input), /direct_plan_review_no_grant/);
  assert.deepEqual(await runtime.ledger.get(item.id), item);
});

test('review rejects another request or item and a stale digest without changing either request', async context => {
  const { runtime, request, item } = await setup(context);
  const other = await requestWork(runtime, 'odrade', 'lucilla', { ...proposal, title: 'A different task' }, undefined, origin);
  await processRequest(runtime, other.id);
  const input = await approval(runtime, request.id);
  await assert.rejects(reviewDirectRequestPlan(runtime, 'odrade', { ...input, request: other.id }), /direct_plan_review_binding_mismatch/);
  await assert.rejects(reviewDirectRequestPlan(runtime, 'odrade', { ...input, item: (await runtime.requests.get(other.id)).workItem! }), /direct_plan_review_binding_mismatch/);
  await assert.rejects(reviewDirectRequestPlan(runtime, 'odrade', { ...input, digest: '0'.repeat(64) }), /direct_plan_review_stale/);
  assert.deepEqual(await runtime.ledger.get(item.id), item);
});

test('changing the request scope, owner, repository or reverse link invalidates prior review evidence', async context => {
  for (const change of ['scope', 'owner', 'repository', 'request-link'] as const) {
    const { runtime, request, item } = await setup(context);
    const input = await approval(runtime, request.id);
    const mutations = {
      scope: () => runtime.requests.update(request.id, current => ({ ...current, ask: {
        ...current.ask, kind: 'work' as const, purpose: 'Different scope', proposal: { ...proposal, acceptance: ['Do something else'] },
      } })),
      owner: () => runtime.ledger.update(item.id, current => ({ ...current, owner: 'clippy' })),
      repository: () => runtime.ledger.update(item.id, current => ({ ...current, proposal: { ...current.proposal, repository: 'example/clippy' } })),
      'request-link': () => runtime.ledger.update(item.id, current => ({ ...current, request: 'r-some-other-request' })),
    };
    await mutations[change]();
    await assert.rejects(reviewDirectRequestPlan(runtime, 'odrade', input), /direct_plan_review_(binding_mismatch|stale)/, change);
    assert.equal((await runtime.ledger.get(item.id)).planApproval, undefined);
  }
});

test('a changed plan invalidates an old review while a new exact review can approve the revision', async context => {
  const { runtime, request, item } = await setup(context);
  const input = await approval(runtime, request.id);
  await submitPlan(runtime, 'lucilla', { item: item.id, title: proposal.title, goal: planGoal,
    plan: `${matchedPlan}\nKeep the installation examples shorter.` }, planningOrigin);
  await assert.rejects(reviewDirectRequestPlan(runtime, 'odrade', input), /direct_plan_review_stale/);
  const currentInput = await approval(runtime, request.id);
  assert.notEqual(currentInput.digest, input.digest);
  assert.equal((await reviewDirectRequestPlan(runtime, 'odrade', currentInput)).status, 'working');
});

test('revision retains original request scope and old review receipts, and identical plan text needs a new review generation', async context => {
  const { runtime, request, item } = await setup(context);
  const input = await approval(runtime, request.id);
  const revised = await reviewDirectRequestPlan(runtime, 'odrade', { ...input, decision: 'revise',
    note: 'Keep all changes in Markdown and retain the contract-pinned README sections.' });
  assert.equal(revised.status, 'planning');
  assert.equal(revised.humanNotes.filter(note => note.kind === 'plan-feedback').length, 1);
  assert.equal(revised.planApproval, undefined);
  assert.deepEqual((await runtime.requests.get(request.id)).ask, request.ask);
  await submitPlan(runtime, 'lucilla', { item: item.id, title: proposal.title, goal: planGoal, plan: matchedPlan }, planningOrigin);
  const fresh = await approval(runtime, request.id);
  assert.notEqual(fresh.digest, input.digest, 'feedback creates a new review generation even when plan text repeats');
  await assert.rejects(reviewDirectRequestPlan(runtime, 'odrade', input), /direct_plan_review_(stale|already_decided)/);
  const approved = await reviewDirectRequestPlan(runtime, 'odrade', fresh);
  assert.deepEqual(approved.directRequestPlanReviews.map(review => review.decision), ['revise', 'approve']);
});

test('a human approval, revision or cancellation winning the mutation race is never overwritten', async context => {
  const actions = { approve: approvePlan, revise: revisePlan, cancel: cancelItem };
  for (const action of Object.values(actions)) {
    const { runtime, request, item } = await setup(context);
    const input = await approval(runtime, request.id);
    const hold = holdMutation(runtime);
    const pending = reviewDirectRequestPlan(runtime, 'odrade', input);
    const rejected = assert.rejects(pending, /not_awaiting_plan_approval|direct_plan_review_stale/);
    await hold.started;
    let decided;
    try {
      await action(runtime, item.id, 'person', 'A newer explicit human decision');
      decided = await runtime.ledger.get(item.id);
    } finally {
      hold.release();
    }
    await rejected;
    assert.deepEqual(await runtime.ledger.get(item.id), decided);
  }
});

test('grant revocation between eligibility and the locked mutation prevents approval', async context => {
  const { runtime, request, lucillaPath, item } = await setup(context);
  const input = await approval(runtime, request.id);
  const hold = holdMutation(runtime);
  const pending = reviewDirectRequestPlan(runtime, 'odrade', input);
  const rejected = assert.rejects(pending, /direct_plan_review_no_grant/);
  await hold.started;
  try {
    await revoke(lucillaPath);
  } finally {
    hold.release();
  }
  await rejected;
  assert.deepEqual(await runtime.ledger.get(item.id), item);
});

function revisionTransport() {
  const messages: string[] = [];
  const client: PlanRevisionClient = {
    exists: async () => true, idle: async () => true, messages: async () => messages,
    prompt: async (target, _agent, text, id) => {
      assert.deepEqual(target, planningOrigin);
      assert.match(text, /Keep the goal/);
      messages.push(id);
    },
  };
  return { client, messages };
}

test('a prepared manager revision recovers before or after the atomic transition with one receipt and one continuation', async context => {
  for (const afterTransition of [false, true]) {
    const { runtime, request, item, declarations } = await setup(context);
    const input = { ...await approval(runtime, request.id), decision: 'revise' as const, note: 'Keep the pinned sections in Markdown.' };
    const update = runtime.ledger.updateIfChanged.bind(runtime.ledger);
    runtime.ledger.updateIfChanged = async (...args) => {
      if (afterTransition) await update(...args);
      throw new Error('fixture_crash_at_transition');
    };
    await assert.rejects(reviewDirectRequestPlan(runtime, 'odrade', input), /fixture_crash_at_transition/);
    assert.equal((await planRevisionStatus(runtime, item.id))?.status, 'prepared');
    const reopened = await Runtime.open({ declarations, state: runtime.stateDirectory });
    const transport = revisionTransport();
    const fail = (_id: string, error: unknown): never => { throw error; };
    await deliverPlanRevisions(reopened, transport.client, fail);
    await deliverPlanRevisions(reopened, transport.client, fail);
    const recovered = await reopened.ledger.get(item.id);
    assert.equal(recovered.status, 'planning');
    assert.equal(recovered.directRequestPlanReviews.length, 1);
    assert.equal(recovered.humanNotes.filter(note => note.kind === 'plan-feedback').length, 1);
    assert.equal(transport.messages.length, 1);
    assert.equal((await planRevisionStatus(reopened, item.id))?.status, 'delivered');
    assert.deepEqual(await reviewDirectRequestPlan(reopened, 'odrade', input), recovered);
    assert.deepEqual((await reopened.requests.get(request.id)).ask, request.ask);
  }
});

test('restart suppresses an unapplied manager revision when its grant has been revoked', async context => {
  const { runtime, request, item, declarations, lucillaPath } = await setup(context);
  const input = { ...await approval(runtime, request.id), decision: 'revise' as const, note: 'Keep the pinned sections in Markdown.' };
  runtime.ledger.updateIfChanged = async () => { throw new Error('fixture_crash_before_transition'); };
  await assert.rejects(reviewDirectRequestPlan(runtime, 'odrade', input), /fixture_crash_before_transition/);
  await revoke(lucillaPath);
  const reopened = await Runtime.open({ declarations, state: runtime.stateDirectory });
  const transport = revisionTransport();
  await deliverPlanRevisions(reopened, transport.client, (_id, error) => { throw error; });
  assert.deepEqual(await reopened.ledger.get(item.id), item);
  assert.equal(transport.messages.length, 0);
  const status = await planRevisionStatus(reopened, item.id);
  assert.equal(status?.status, 'suppressed');
  assert.match(status!.reason!, /direct_plan_review_no_grant/);
});

test('the existing manager revision budget stops autonomous loops while preserving human approval and old retries', async context => {
  const { runtime, request, item } = await setup(context);
  let lastReview = { ...await approval(runtime, request.id), decision: 'revise' as const };
  for (let generation = 0; generation < SUPERVISION_LIMITS.revisionsPerItem; generation++) {
    lastReview = { ...await approval(runtime, request.id), decision: 'revise', note: `Shorten reference section ${generation + 1}.` };
    await reviewDirectRequestPlan(runtime, 'odrade', lastReview);
    await submitPlan(runtime, 'lucilla', { item: item.id, title: proposal.title, goal: planGoal,
      plan: `${matchedPlan}\nReference revision ${generation + 1}.` }, planningOrigin);
  }
  const bounded = await runtime.ledger.get(item.id);
  assert.equal(bounded.directRequestPlanReviews.length, SUPERVISION_LIMITS.revisionsPerItem);
  await assert.rejects(getDirectRequestReview(runtime, request.id), /direct_plan_review_revision_limit/);
  await assert.rejects(reviewDirectRequestPlan(runtime, 'odrade', {
    ...lastReview, digest: '0'.repeat(64), decision: 'approve',
  }), /direct_plan_review_revision_limit/);
  assert.deepEqual(await reviewDirectRequestPlan(runtime, 'odrade', lastReview), bounded);
  const approved = await approvePlan(runtime, item.id, 'person', 'The revised Markdown-only plan meets the request.');
  assert.equal(approved.status, 'working');
  assert.equal(approved.planApproval?.by, 'person');
  assert.deepEqual(approved.directRequestPlanReviews, bounded.directRequestPlanReviews);
});

function holdRevisionRequestLock(runtime: Runtime) {
  const inspect = runtime.requests.inspectLocked.bind(runtime.requests);
  let inspected = 0;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  runtime.requests.inspectLocked = async (id, operation) => {
    if (++inspected === 2) {
      runtime.requests.inspectLocked = inspect;
      entered();
      await gate;
    }
    return inspect(id, operation);
  };
  return { started, release };
}

test('a needs-human decision winning against a prepared revision cannot be replaced while the gate remains waiting', async context => {
  const { runtime, request, item } = await setup(context);
  const input = await approval(runtime, request.id);
  const hold = holdRevisionRequestLock(runtime);
  const pending = reviewDirectRequestPlan(runtime, 'odrade', { ...input, decision: 'revise', note: 'Remove the Go test changes.' });
  const rejected = assert.rejects(pending, /direct_plan_review_already_decided/);
  await hold.started;
  try {
    await reviewDirectRequestPlan(runtime, 'odrade', { ...input, decision: 'needs-human', scope: 'needs-human',
      note: 'The person must decide whether Go documentation-contract edits fit the request.' });
  } finally {
    hold.release();
  }
  await rejected;
  const retained = await runtime.ledger.get(item.id);
  assert.equal(retained.status, 'awaiting-plan-approval');
  assert.equal(retained.planApproval, undefined);
  assert.deepEqual(retained.directRequestPlanReviews.map(review => review.decision), ['needs-human']);
  assert.equal(retained.humanNotes.filter(note => note.kind === 'plan-feedback').length, 0);
  const transport = revisionTransport();
  await deliverPlanRevisions(runtime, transport.client, (_id, error) => { throw error; });
  assert.equal(transport.messages.length, 0);
  assert.equal((await planRevisionStatus(runtime, item.id))?.status, 'suppressed');
});

test('a crash before or after the first journal append is repaired by an exact retry without duplicate approval or audit entries', async context => {
  for (const afterAppend of [false, true]) {
    const { runtime, request, item, declarations } = await setup(context);
    const input = await approval(runtime, request.id);
    const notebook = runtime.notebook.bind(runtime);
    runtime.notebook = owner => {
      const current = notebook(owner);
      const append = current.journalOnce.bind(current);
      current.journalOnce = async (...args) => {
        if (afterAppend) await append(...args);
        throw new Error('fixture_crash_at_audit_append');
      };
      return current;
    };
    await assert.rejects(reviewDirectRequestPlan(runtime, 'odrade', input), /fixture_crash_at_audit_append/);
    const approved = await runtime.ledger.get(item.id);
    assert.equal(approved.status, 'working');
    const reopened = await Runtime.open({ declarations, state: runtime.stateDirectory });
    await reviewDirectRequestPlan(reopened, 'odrade', input);
    await reviewDirectRequestPlan(reopened, 'odrade', input);
    assert.deepEqual(await reopened.ledger.get(item.id), approved);
    for (const owner of ['odrade', 'lucilla']) {
      const events = (await journal(reopened, owner)).split('\n').filter(line => line.includes(`direct-request-plan-review:${input.digest}`));
      assert.equal(events.length, 1, `${owner} has exactly one durable audit event`);
      assert.equal(JSON.parse(events[0]).kind, 'grant-used');
    }
  }
});

test('invalid path identifiers and malformed binding digests are rejected before record I/O or lock creation', async context => {
  const { runtime, request } = await setup(context);
  const input = await approval(runtime, request.id);
  runtime.requests.inspectLocked = async () => { throw new Error('unexpected_record_io'); };
  runtime.ledger.get = async () => { throw new Error('unexpected_record_io'); };
  const invalid = [
    { request: '../outside' }, { request: 'r-parent/../outside' }, { request: '/tmp/outside' },
    { item: '../outside' }, { item: 'w-parent/../outside' }, { item: '/tmp/outside' },
    { digest: 'incorrect' }, { digest: '0'.repeat(63) }, { digest: 'G'.repeat(64) },
  ];
  for (const fields of invalid) {
    await assert.rejects(reviewDirectRequestPlan(runtime, 'odrade', { ...input, ...fields }), { name: 'ZodError' });
  }
  for (const invalidRequest of ['../outside', 'r-parent/../outside', '/tmp/outside']) {
    await assert.rejects(getDirectRequestReview(runtime, invalidRequest), { name: 'ZodError' });
  }
});
