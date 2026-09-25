import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { editSection, familyOf, Ledger, loadDeclarations, pickModel } from '@onionsoup/owners';

const families = {
  families: [
    { family: 'anthropic', match: ['github-copilot/claude-*'] },
    { family: 'openai', match: ['openai/*', 'github-copilot/gpt-*'] },
  ],
};

test('review model is picked outside the implementer family', () => {
  assert.equal(familyOf(families, 'github-copilot/claude-sonnet-5'), 'anthropic');
  const pick = pickModel(families, ['github-copilot/claude-sonnet-5', 'openai/gpt-5.6-sol'], ['anthropic']);
  assert.deepEqual(pick, { model: 'openai/gpt-5.6-sol', family: 'openai' });
  assert.throws(() => pickModel(families, ['github-copilot/claude-sonnet-5'], ['anthropic']), /no_model_outside_families/);
  assert.throws(() => familyOf(families, 'mystery/model'), /unknown_model_family/);
});

test('notebook edits append to or replace one section', () => {
  const start = '# Wisdom\n\n## Testing\n\nUse table tests.\n\n## Style\n\ngofmt.\n';
  const appended = editSection(start, { register: 'WISDOM', mode: 'append', section: 'Testing', text: 'Golden images live in testdata.' });
  assert.match(appended, /Use table tests\.\n\nGolden images live in testdata\.\n\n## Style/);
  const replaced = editSection(appended, { register: 'WISDOM', mode: 'replace-section', section: 'Style', text: 'gofmt and go vet.' });
  assert.match(replaced, /## Style\n\ngofmt and go vet\.\n$/);
  const added = editSection(start, { register: 'WISDOM', mode: 'append', section: 'Releases', text: 'GoReleaser on tags.' });
  assert.match(added, /## Releases\n\nGoReleaser on tags\.\n$/);
});

test('work stranded mid-stage is marked interrupted, not replayed', async () => {
  const ledger = new Ledger(await mkdtemp(join(tmpdir(), 'owners-')));
  const proposal = { title: 't', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' as const };
  const running = await ledger.create('clippy', 'change', proposal);
  await ledger.save({ ...running, status: 'implementing', activeRunner: 424242 });
  const queued = await ledger.create('clippy', 'change', proposal);
  await ledger.save({ ...queued, status: 'implementing' });
  const waiting = await ledger.create('clippy', 'change', proposal);
  await ledger.save({ ...waiting, status: 'awaiting-plan-approval' });
  assert.equal(await ledger.markInterrupted(), 1);
  assert.equal((await ledger.get(running.id)).status, 'interrupted');
  assert.equal((await ledger.get(waiting.id)).status, 'awaiting-plan-approval');
  assert.equal((await ledger.get(queued.id)).status, 'implementing', 'approved but never started stays queued');
});

test('ship refuses before touching the checkout when any owner has an active work runner', async () => {
  const { Runtime } = await import('@onionsoup/owners');
  const { shipEngine } = await import('../src/ship.ts');
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: await mkdtemp(join(tmpdir(), 'owners-ship-')) });
  const clippy = runtime.declarations.owners.get('clippy');
  assert.ok(clippy);
  runtime.declarations.owners.set('clippy', {
    ...clippy,
    deploy: { checkout: join(runtime.stateDirectory, 'nonexistent-checkout'), services: ['onionsoup-owners.service'] },
  });
  const proposal = { title: 'Shipping work', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' as const };
  const planning = await runtime.ledger.create('clippy', 'change', proposal);
  await runtime.ledger.save({ ...planning, status: 'planning', activeRunner: 424242 });
  const reviewing = await runtime.ledger.create('homelab', 'change', { ...proposal, title: 'Another owner reviewing' });
  await runtime.ledger.save({ ...reviewing, status: 'reviewing', activeRunner: 424243 });
  const queued = await runtime.ledger.create('clippy', 'change', { ...proposal, title: 'Queued work' });
  await runtime.ledger.save({ ...queued, status: 'implementing' });

  const shipped = await shipEngine(runtime, 'clippy');
  assert.equal(shipped.outcome, 'failed');
  assert.match(shipped.summary, /running_work_items/);
  assert.match(shipped.summary, new RegExp(`${planning.id}.*Shipping work.*planning`));
  assert.match(shipped.summary, new RegExp(`${reviewing.id}.*Another owner reviewing.*reviewing`));
  assert.doesNotMatch(shipped.summary, new RegExp(queued.id));
  assert.doesNotMatch(shipped.summary, /Queued work/);
});

test('example declarations load and reference known models', async () => {
  const declarations = await loadDeclarations('packages/owners/test/fixtures/owners');
  const clippy = declarations.owners.get('clippy');
  assert.ok(clippy);
  for (const freelancer of declarations.freelancers.values()) {
    for (const model of freelancer.models) familyOf(declarations.families, model);
  }
  familyOf(declarations.families, clippy.model);
});

test('the org chart comes from reportsTo, refuses unknown managers, self-reports and cycles, and renders as a tree', async () => {
  const { cp: copy, writeFile: write, readFile: read } = await import('node:fs/promises');
  const { directReports, isDirectReport, managerOf } = await import('@onionsoup/owners');
  const { orgText, rosterText } = await import('../src/roster.ts');
  const declarations = await loadDeclarations('packages/owners/test/fixtures/owners');
  assert.equal(managerOf(declarations, 'clippy')?.id, 'odrade');
  assert.equal(managerOf(declarations, 'odrade'), undefined);
  assert.deepEqual(directReports(declarations, 'odrade').map(owner => owner.id).sort(), ['bellonda', 'clippy']);
  assert.equal(isDirectReport(declarations, 'odrade', 'bellonda'), true);
  assert.equal(isDirectReport(declarations, 'homelab', 'bellonda'), false);

  const roster = rosterText(declarations, 'clippy');
  assert.match(roster, /\n- Odrade, Mother Superior of the test org \[owner id: odrade\]/);
  assert.match(roster, /\n {2}- Bellonda, Keeper of the test wiki \[owner id: bellonda\]/);
  assert.match(roster, /\n {2}- Clippy, Keeper of the test tool \(you\) \[owner id: clippy\]/);
  declarations.owners.set('clippy', { ...declarations.owners.get('clippy')!, persona: undefined });
  assert.match(rosterText(declarations, 'clippy'), /\n {2}- clippy \(no persona\) \(you\) \[owner id: clippy\]/);
  assert.match(orgText(declarations, 'clippy'), /^Your manager: Odrade/);
  assert.match(orgText(declarations, 'odrade'), /Your direct reports: .*bellonda.*clippy/);
  assert.equal(orgText(declarations, 'homelab'), '');

  const config = await mkdtemp(join(tmpdir(), 'owners-org-'));
  await copy('packages/owners/test/fixtures/owners', config, { recursive: true });
  const homelab = await read(join(config, 'owners', 'homelab.yaml'), 'utf8');
  const cases: [string, RegExp][] = [
    ['reportsTo: nobody', /org_chart_unknown_manager: homelab reports to nobody/],
    ['reportsTo: homelab', /org_chart_self: homelab/],
    ['reportsTo: clippy', /org_chart_cycle/],
    ['grants: [{ to: odrade, action: approve-plans, target: "*" }]', /grant_not_to_manager: homelab grants approve-plans to odrade, who is not its manager/],
  ];
  const odrade = await read(join(config, 'owners', 'odrade.yaml'), 'utf8');
  await write(join(config, 'owners', 'odrade.yaml'), `${odrade}reportsTo: homelab\n`);
  for (const [line, expected] of cases) {
    await write(join(config, 'owners', 'homelab.yaml'), `${homelab}${line}\n`);
    await assert.rejects(loadDeclarations(config), expected);
  }
});

test('a person sends an owner plan back with feedback; only owner plans are approved, and the retired pipeline\'s work is failed once', async () => {
  const { Runtime, approvePlan, revisePlan, retirePipelineItems } = await import('@onionsoup/owners');
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: await mkdtemp(join(tmpdir(), 'owners-state-')) });
  await runtime.notebook('clippy').ensure('# Charter\n');
  const proposal = { title: 't', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' as const };
  const planDocument = { markdown: '1. Bound the font size', digest: 'd' };
  const planned = await runtime.ledger.create('clippy', 'owner-change', proposal, { status: 'awaiting-plan-approval', planDocument });
  const revised = await revisePlan(runtime, planned.id, 'bjk', 'also bound -font-size');
  assert.equal(revised.status, 'planning');
  assert.deepEqual(revised.humanNotes.map(note => [note.kind, note.note]), [['plan-feedback', 'also bound -font-size']]);
  const legacy = await runtime.ledger.create('clippy', 'change', proposal, { status: 'awaiting-plan-approval' });
  await assert.rejects(approvePlan(runtime, legacy.id, 'bjk'), /not_an_owner_plan/);
  const implementing = await runtime.ledger.create('clippy', 'change', proposal, { status: 'implementing' });
  const landed = await runtime.ledger.create('clippy', 'change', proposal, { status: 'landed' });
  assert.deepEqual((await retirePipelineItems(runtime)).sort(), [legacy.id, implementing.id].sort());
  assert.equal((await runtime.ledger.get(implementing.id)).reason, 'pipeline_removed');
  assert.equal((await runtime.ledger.get(landed.id)).status, 'landed', 'finished work stays as it was');
  assert.equal((await runtime.ledger.get(planned.id)).status, 'planning', 'owner plans are not touched');
  assert.deepEqual(await retirePipelineItems(runtime), [], 'once');
});

test('survey context says when landed work is not yet on the base branch', async () => {
  const { workSoFarText } = await import('../src/briefs.ts');
  const base = { owner: 'clippy', workflow: 'desk-publication', implementations: [], verdicts: [], replans: 0, hires: [], humanNotes: [], createdAt: '', updatedAt: '' };
  const proposal = { title: 'Alignment tests', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' as const };
  const publication = { url: 'https://github.com/x/y/pull/2', branch: 'owners/w-3', by: 'clippy', at: '', state: 'open' as const };
  const text = workSoFarText([
    { ...base, id: 'w-1', proposal, status: 'landed', branch: 'owners/w-1' },
    { ...base, id: 'w-2', proposal: { ...proposal, title: 'Clipboard note' }, status: 'rejected', reason: 'busywork' },
    { ...base, id: 'w-3', proposal: { ...proposal, title: 'Cursor fix' }, status: 'landed', publication },
  ]);
  assert.match(text, /Alignment tests \[w-1\]: landed on owners\/w-1, NOT on the base branch/);
  assert.match(text, /Cursor fix \[w-3\]: published as https:\/\/github.com\/x\/y\/pull\/2 \(open\)/);
  assert.match(text, /Clipboard note \[w-2\]: plan rejected by a person: busywork/);
});

async function incusRuntime() {
  const { Runtime } = await import('@onionsoup/owners');
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: await mkdtemp(join(tmpdir(), 'owners-incus-')) });
  const calls: string[][] = [];
  runtime.incus = { run: async args => { calls.push([...args]); return args[0] === 'list' || args[1] === 'list' ? '[]' : ''; } };
  for (const ownerId of ['clippy', 'homelab', 'moneo']) await runtime.notebook(ownerId).ensure('# Charter\n');
  return { runtime, calls };
}

test('an approved lease creates, runs the follow-up, and deletes without a second prompt', async () => {
  const { approveCreate, processRequests, FOLLOW_UPS } = await import('../src/brokering.ts');
  const { runtime, calls } = await incusRuntime();
  FOLLOW_UPS['test-follow-up'] = async (_runtime, request) => ({ ok: true, summary: `used ${request.instance!.name}` });
  const ask = { kind: 'instance' as const, image: 'images:debian/13', purpose: 'smoke test', expectedMinutes: 10 };
  const opened = await runtime.requests.open('clippy', 'homelab', ask, 'test-follow-up');
  const decision = { decision: 'accept' as const, reply: 'ok', remote: 'minideb', image: 'images:debian/13', nameSuffix: 'clippy-smoke' };
  await runtime.requests.save({ ...opened, status: 'awaiting-create-approval', decision });
  await approveCreate(runtime, opened.id, 'bjk', true);
  await processRequests(runtime);
  const done = await runtime.requests.get(opened.id);
  assert.equal(done.status, 'deleted');
  assert.equal(done.followUpResult?.summary, 'used onionsoup-clippy-smoke');
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [['launch', 'images:debian/13'], ['delete', '--force']]);
  assert.deepEqual(await runtime.managed.list('homelab'), []);
});

test('without a lease the release waits for a delete approval', async () => {
  const { approveCreate, approveDelete, processRequests, FOLLOW_UPS } = await import('../src/brokering.ts');
  const { runtime } = await incusRuntime();
  FOLLOW_UPS['test-follow-up'] = async () => ({ ok: true, summary: 'fine' });
  const ask = { kind: 'instance' as const, image: 'images:debian/13', purpose: 'p', expectedMinutes: 5 };
  const opened = await runtime.requests.open('clippy', 'homelab', ask, 'test-follow-up');
  await runtime.requests.save({ ...opened, status: 'awaiting-create-approval', decision: { decision: 'accept', reply: 'ok', remote: 'minideb', image: 'images:debian/13', nameSuffix: 'x' } });
  await approveCreate(runtime, opened.id, 'bjk', false);
  await processRequests(runtime);
  assert.equal((await runtime.requests.get(opened.id)).status, 'awaiting-delete-approval');
  await approveDelete(runtime, opened.id, 'bjk');
  await processRequests(runtime);
  assert.equal((await runtime.requests.get(opened.id)).status, 'deleted');
});

test('create and delete guards hold regardless of what an owner decides', async () => {
  const { checkCreate, deleteInstance } = await import('../src/incus.ts');
  const { runtime, calls } = await incusRuntime();
  const owner = runtime.incusOwner('homelab');
  await assert.rejects(checkCreate(owner, runtime.managed, { remote: 'selfie', image: 'images:debian/13', nameSuffix: 'x' }), /remote_forbids_create: selfie/);
  await assert.rejects(checkCreate(owner, runtime.managed, { remote: 'minideb', image: 'images:alpine/edge', nameSuffix: 'x' }), /image_not_allowed/);
  await assert.rejects(checkCreate(owner, runtime.managed, { remote: 'minideb', image: 'images:debian/13', nameSuffix: 'Bad Name' }), /bad_instance_name/);
  await assert.rejects(deleteInstance(runtime.incus, owner, runtime.managed, 'minideb', 'onionsoup-not-mine'), /not_managed_by_onionsoup/);
  await assert.rejects(deleteInstance(runtime.incus, owner, runtime.managed, 'selfie', 'bobsled'), /remote_forbids_delete: selfie/);
  assert.deepEqual(calls, []);
});

test('a publish request from an owner that is not the site source is refused before anyone is asked', async () => {
  const { runtime } = await incusRuntime();
  await runtime.notebook('moneo').ensure('# Charter\n');
  const { requestPublish, decide } = await import('../src/brokering.ts');
  const request = await requestPublish(runtime, 'clippy', 'homelab-wiki', 'try to publish a site it does not own');
  const decided = await decide(runtime, request.id);
  assert.equal(decided.status, 'declined');
  assert.match(decided.reason ?? '', /clippy is not the source of homelab-wiki/);
  await assert.rejects(requestPublish(runtime, 'bellonda', 'no-such-site', 'x'), /no owner hosts site no-such-site/);
});

test('an app update Moneo decided is approved by his standing grant without a person', async () => {
  const { runtime } = await incusRuntime();
  await runtime.notebook('moneo').ensure('# Charter\n');
  const { decide } = await import('../src/brokering.ts');
  const ask = { kind: 'update-app' as const, app: 'radarr', fromVersion: '1.4.15', toVersion: '1.4.17', purpose: 'patch release, no breaking changes', notesRead: [] };
  const request = await runtime.requests.open('moneo', 'moneo', ask, 'none');
  const decided = await decide(runtime, request.id);
  assert.equal(decided.status, 'create-approved');
  assert.match(decided.approvals.at(-1)!.by, /standing grant in moneo's declaration \(update-app \* for moneo\)/);
});

test('a section body that repeats its own heading does not double the heading', () => {
  const result = editSection('# Map\n', { register: 'MAP', mode: 'append', section: 'Storage layout', text: '## Storage layout\n\n- fast: NVMe pool' });
  assert.equal(result.match(/## Storage layout/g)?.length, 1);
  assert.match(result, /## Storage layout\n\n- fast: NVMe pool\n$/);
});

test('the starter a new person begins from loads and its models belong to known families', async () => {
  const declarations = await loadDeclarations('examples/starter');
  const example = declarations.owners.get('example');
  assert.ok(example?.persona);
  familyOf(declarations.families, example.model);
  for (const freelancer of declarations.freelancers.values()) for (const model of freelancer.models) familyOf(declarations.families, model);
  assert.deepEqual([...declarations.freelancers.keys()].sort(), ['implementation', 'review']);
});

test('a config that still declares the retired planner and workflows loads, and its workflow lines are ignored', async () => {
  const { cp, writeFile: write, mkdir: makeDirectory, readFile: read } = await import('node:fs/promises');
  const config = await mkdtemp(join(tmpdir(), 'owners-retired-config-'));
  await cp('examples/starter', config, { recursive: true });
  await write(join(config, 'freelancers', 'planner.yaml'), 'craft: planning\nrubric: rubrics/planning.md\nmodels: [openai/gpt-5.6-sol]\n');
  await makeDirectory(join(config, 'workflows'));
  await write(join(config, 'workflows', 'change.yaml'), 'id: change\n');
  const owner = join(config, 'owners', 'example.yaml');
  await write(owner, `${await read(owner, 'utf8')}workflow: change\n`);
  const declarations = await loadDeclarations(config);
  assert.ok(!declarations.freelancers.has('planning' as never));
  assert.equal('workflow' in declarations.owners.get('example')!, false);
});

test('status shows recent outcomes of finished work', async () => {
  const { statusText } = await import('../src/desk.ts');
  const now = new Date('2026-09-23T12:00:00Z');
  const base = { owner: 'murbella', workflow: 'desk-publication', implementations: [], verdicts: [], replans: 0, hires: [], humanNotes: [], createdAt: '2026-09-23T09:30:00Z', updatedAt: '2026-09-23T09:40:00Z' };
  const proposal = { title: 'Fix vscode sysext', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' as const };
  const landed = { ...base, id: 'w-1', proposal, status: 'landed' as const, branch: 'owners/w-1', landedCommit: 'a077b107d06000bd' };
  const rebase = { ...landed, id: 'w-2', rebaseOf: { itemId: 'w-0', branch: 'owners/w-0', prUrl: 'https://github.com/x/y/pull/1', previousHead: 'abc' } };
  const failed = { ...base, id: 'w-3', proposal: { ...proposal, title: 'Deploy action' }, status: 'failed' as const, reason: 'MessageAbortedError: Aborted' };
  const old = { ...landed, id: 'w-4', updatedAt: '2026-09-01T00:00:00Z' };
  const text = statusText([old, landed, rebase, failed], [], now);
  assert.match(text, /^Open: nothing\./);
  assert.match(text, /w-1: landed on owners\/w-1 \(a077b107d060\); no PR/);
  assert.match(text, /w-3: failed: MessageAbortedError: Aborted: Deploy action/);
  assert.doesNotMatch(text, /w-4/);
});

test('a deliverable with a list sent as a JSON string is repaired; a missing field is not invented', async () => {
  const { parseDeliverable } = await import('../src/opencode.ts');
  const { Answer, salvageAnswer } = await import('../src/ask.ts');
  const { HireError } = await import('../src/opencode.ts');
  const stringified = { answer: '[draft] firn is coupled', observed: '["AGENTS.md: firn consumes catalog.json"]', inferred: [], unknown: '[]' };
  const repaired = parseDeliverable(Answer, stringified);
  assert.ok(repaired.success);
  assert.deepEqual(repaired.data, { answer: '[draft] firn is coupled', observed: ['AGENTS.md: firn consumes catalog.json'], inferred: [], unknown: [] });
  assert.equal(parseDeliverable(Answer, { answer: 'a', observed: '["x"]' }).success, false);
  assert.equal(parseDeliverable(Answer, { answer: 'a', observed: 'not json', inferred: [], unknown: [] }).success, false);
  const salvaged = salvageAnswer(new HireError('deliverable_invalid', 'ses_1', { answer: 'firn is coupled', observed: 'x' }));
  assert.equal(salvaged.value.answer, 'firn is coupled');
  assert.throws(() => salvageAnswer(new HireError('deliverable_invalid', 'ses_1', { observed: 'x' })), /deliverable_invalid/);
});

test('a failed hire reply names its cause instead of serialising an Error to {}', async () => {
  const { describeReplyError } = await import('../src/opencode.ts');
  const timeout = new DOMException('The operation timed out.', 'TimeoutError');
  assert.equal(describeReplyError(timeout), 'TimeoutError: The operation timed out.');
  assert.equal(describeReplyError(new TypeError('fetch failed')), 'TypeError: fetch failed');
  assert.equal(describeReplyError({ name: 'BadRequest', data: { message: 'x' } }), '{"name":"BadRequest","data":{"message":"x"}}');
  assert.equal(describeReplyError(undefined), 'null');
});

test('an implementation report omitting filesChanged defaults to an empty array, but summary and deviationsFromPlan stay required', async () => {
  const { parseDeliverable } = await import('../src/opencode.ts');
  const { ImplementationReport } = await import('../src/artifacts.ts');
  const withoutFilesChanged = parseDeliverable(ImplementationReport, { summary: 'did the thing', deviationsFromPlan: [] });
  assert.ok(withoutFilesChanged.success);
  assert.deepEqual(withoutFilesChanged.data, { summary: 'did the thing', filesChanged: [], deviationsFromPlan: [] });
  assert.equal(parseDeliverable(ImplementationReport, { filesChanged: [], deviationsFromPlan: [] }).success, false);
  assert.equal(parseDeliverable(ImplementationReport, { summary: 'did the thing', filesChanged: [] }).success, false);
});

test('a steward creates and retires owners in its scope, and never writes authority or itself', async () => {
  const { cp: copy, writeFile: write, access } = await import('node:fs/promises');
  const { execFileSync } = await import('node:child_process');
  const { Runtime } = await import('@onionsoup/owners');
  const { prepareOwnerWrite, writeOwner, prepareRetire, retireOwner } = await import('../src/stewardship.ts');
  const config = await mkdtemp(join(tmpdir(), 'owners-steward-'));
  await copy('packages/owners/test/fixtures/owners', config, { recursive: true });
  await write(join(config, 'owners', 'odrade.yaml'), 'id: odrade\ndomain: { kind: github-org, org: example }\nmodel: openai/gpt-5.6-sol\nduties: []\nmanages: { owners: ["example/*"] }\n');
  execFileSync('git', ['-C', config, 'init', '-q']);
  execFileSync('git', ['-C', config, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A']);
  execFileSync('git', ['-C', config, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture']);
  const runtime = await Runtime.open({ declarations: config, state: await mkdtemp(join(tmpdir(), 'owners-steward-state-')) });
  await runtime.notebook('odrade').ensure('# Charter\n');
  const widget = 'id: widget\npersona: { name: Tamalane, title: t, source: Heretics, voice: v }\ndomain: { kind: git-repository, name: example/widget, remote: https://example.invalid/widget.git, baseBranch: main, verify: [[make, test]] }\nmodel: github-copilot/claude-sonnet-5\nworkflow: change\nduties: []\n';

  await assert.rejects(prepareOwnerWrite(runtime, 'odrade', widget), /needs a charter/);
  await assert.rejects(prepareOwnerWrite(runtime, 'odrade', `${widget}grants: [{ to: widget, action: merge, target: example/widget }]\n`), /grants is authority/);
  await assert.rejects(prepareOwnerWrite(runtime, 'odrade', widget.replace('example/widget', 'elsewhere/widget'), '# c'), /outside odrade's scope/);
  await assert.rejects(prepareOwnerWrite(runtime, 'odrade', widget.replace('example/widget', 'example/wiki'), '# c'), /bellonda already owns example\/wiki/);
  const fleet = execFileSync('cat', [join(config, 'owners', 'homelab.yaml')]).toString().replace(/\nincus:[\s\S]*?(?=\n[a-z]+:|$)/, '');
  await assert.rejects(prepareOwnerWrite(runtime, 'odrade', fleet), /incus is authority/);
  await assert.rejects(prepareOwnerWrite(runtime, 'odrade', 'id: odrade\ndomain: { kind: github-org, org: example }\nmodel: openai/gpt-5.6-sol\nduties: []\nmanages: { owners: ["*"] }\n'), /own declaration/);
  await assert.rejects(prepareOwnerWrite(runtime, 'clippy', widget, '# c'), /not_a_steward/);

  await assert.rejects(prepareOwnerWrite(runtime, 'odrade', `${widget}reportsTo: bellonda\n`, '# c'), /reportsTo may only name you/);
  const underOdrade = await prepareOwnerWrite(runtime, 'odrade', `${widget}reportsTo: odrade\n`, '# c');
  assert.equal(underOdrade.candidate.reportsTo, 'odrade');
  await write(join(config, 'owners', 'homelab.yaml'), `${execFileSync('cat', [join(config, 'owners', 'homelab.yaml')])}reportsTo: bellonda\n`);
  await runtime.reloadDeclarations();
  const homelabNow = execFileSync('cat', [join(config, 'owners', 'homelab.yaml')]).toString();
  await assert.rejects(prepareOwnerWrite(runtime, 'odrade', homelabNow.replace('reportsTo: bellonda\n', '')), /reportsTo may only name you/);
  await assert.rejects(prepareOwnerWrite(runtime, 'odrade', homelabNow.replace('reportsTo: bellonda', 'reportsTo: odrade')), /reportsTo may only name you/);
  await write(join(config, 'owners', 'homelab.yaml'), homelabNow.replace('reportsTo: bellonda\n', ''));
  await runtime.reloadDeclarations();
  const prepared = await prepareOwnerWrite(runtime, 'odrade', widget, '# Charter: widget\n');
  assert.equal(prepared.created, true);
  await writeOwner(runtime, 'odrade', prepared);
  assert.ok(runtime.declarations.owners.has('widget'));
  assert.match(execFileSync('git', ['-C', config, 'log', '-1', '--format=%s']).toString(), /Add Tamalane \(example\/widget\), by odrade/);

  await runtime.ledger.create('widget', 'change', { title: 'Cancelled', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' }, { status: 'cancelled' });
  const retiring = await prepareRetire(runtime, 'odrade', 'widget');
  await retireOwner(runtime, 'odrade', retiring, 'merged into clippy');
  assert.equal(runtime.declarations.owners.has('widget'), false);
  await access(join(config, 'retired', 'widget.yaml'));
  assert.equal(execFileSync('git', ['-C', config, 'status', '--porcelain']).toString(), '');
});

test('a group owner owns several repositories, each with its own checkout, desk and work items', async () => {
  const { cp: copy, writeFile: write, access } = await import('node:fs/promises');
  const { execFileSync } = await import('node:child_process');
  const { Runtime } = await import('@onionsoup/owners');
  const { refreshWorkspace } = await import('../src/owner.ts');
  const { ensureDesk } = await import('../src/workspace.ts');
  const { prepareOwnerWrite } = await import('../src/stewardship.ts');
  const scratch = await mkdtemp(join(tmpdir(), 'owners-group-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).toString();
  for (const name of ['lab', 'testsuite']) {
    git('init', '-q', '-b', 'main', join(scratch, 'remotes', name));
    await write(join(scratch, 'remotes', name, 'README.md'), `# ${name}\n`);
    git('-C', join(scratch, 'remotes', name), 'add', '-A');
    git('-C', join(scratch, 'remotes', name), 'commit', '-qm', 'init');
  }
  const config = join(scratch, 'config');
  await copy('packages/owners/test/fixtures/owners', config, { recursive: true });
  const member = (name: string) => `{ name: example/${name}, remote: ${join(scratch, 'remotes', name)}, baseBranch: main, verify: [[make, check]] }`;
  const group = `id: platform\npersona: { name: Tamalane, title: t, source: Heretics, voice: v }\ndomain:\n  kind: repository-group\n  name: example/platform\n  repositories:\n    - ${member('lab')}\n    - ${member('testsuite')}\nmodel: github-copilot/claude-sonnet-5\nworkflow: change\nduties: []\n`;
  await write(join(config, 'owners', 'platform.yaml'), group);
  await write(join(config, 'owners', 'odrade.yaml'), 'id: odrade\ndomain: { kind: github-org, org: example }\nmodel: openai/gpt-5.6-sol\nduties: []\nmanages: { owners: ["example/*"] }\n');
  const runtime = await Runtime.open({ declarations: config, state: join(scratch, 'home', 'state') });

  assert.throws(() => runtime.repositoryOwner('platform'), /which_repository: platform owns example\/lab, example\/testsuite/);
  assert.throws(() => runtime.repositoryOwner('platform', 'example/wiki'), /not_your_repository/);
  const lab = runtime.repositoryOwner('platform', 'example/lab');
  assert.equal(lab.domain.kind, 'git-repository');
  assert.equal(lab.workspace, join(scratch, 'home', 'checkouts', 'platform', 'lab'));
  assert.equal(lab.desk, join(scratch, 'home', 'desks', 'platform', 'lab'));
  assert.equal(runtime.repositoryOwner('clippy').domain.name, 'example/clippy');

  const label = await refreshWorkspace(runtime, runtime.owner('platform'));
  assert.match(label, /example\/lab in \.\/lab at commit [0-9a-f]{12}; example\/testsuite in \.\/testsuite/);
  await access(join(scratch, 'home', 'checkouts', 'platform', 'testsuite', 'README.md'));
  const desk = await ensureDesk(runtime.repositoryOwner('platform', 'example/testsuite'), runtime.desksRoot);
  assert.equal(desk.path, join(scratch, 'home', 'desks', 'platform', 'testsuite'));
  await access(join(desk.path, 'README.md'));

  const item = await runtime.ledger.create('platform', 'change', { title: 't', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small', repository: 'example/testsuite' });
  assert.equal(runtime.repositoryFor(item).workspace, join(scratch, 'home', 'checkouts', 'platform', 'testsuite'));

  const overlapping = group.replace('id: platform', 'id: platform2').replace('Tamalane', 'Sheeana').replace('example/platform', 'example/platform2');
  await assert.rejects(prepareOwnerWrite(runtime, 'odrade', overlapping, '# c'), /platform already owns example\/lab, example\/testsuite/);
  const partlyOutside = overlapping.replace(`example/lab, remote`, `elsewhere/lab, remote`);
  await assert.rejects(prepareOwnerWrite(runtime, 'odrade', partlyOutside, '# c'), /outside odrade's scope/);
  const repeated = group.replace('example/testsuite', 'other/lab');
  await write(join(config, 'owners', 'platform.yaml'), repeated);
  await assert.rejects(runtime.reloadDeclarations(), /repository names must differ after the owner: lab/);
});

test('the implementer may run anything in its sandbox except commit, push, gh and sudo', async () => {
  const { IMPLEMENTER_BASH } = await import('../src/opencode.ts');
  const entries = Object.entries(IMPLEMENTER_BASH);
  assert.deepEqual(entries[0], ['*', 'allow']);
  for (const pattern of ['git commit*', 'git * push*', 'gh *', 'sudo *']) assert.equal(IMPLEMENTER_BASH[pattern], 'deny');
  assert.ok(entries.slice(1).every(([, action]) => action === 'deny'), 'denies come after the allow, so they win');
});

test('owners hear how their work went: changes are journaled and queued for the chat the work came from, once', async () => {
  const { Runtime } = await import('@onionsoup/owners');
  const { noticeWorkChanges, pendingNotices, claimNotice, describeChange } = await import('../src/notices.ts');
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: await mkdtemp(join(tmpdir(), 'owners-notices-')) });
  await runtime.notebook('clippy').ensure('# Charter\n');
  const proposal = { title: 'Fix it', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' as const };
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, { origin: { sessionID: 'ses_1', directory: '/desks/clippy' } });
  const chatDirectory = async (ownerId: string) => `/desks/${ownerId}`;

  assert.deepEqual(await noticeWorkChanges(runtime, chatDirectory), [], 'the first run records the present and replays nothing');
  await runtime.ledger.save({ ...item, status: 'working' });
  assert.deepEqual(await noticeWorkChanges(runtime, chatDirectory), [], 'progress the owner need not act on is not a notice');
  await runtime.ledger.save({ ...item, status: 'failed', reason: 'MessageAbortedError: Aborted' });
  const [notice] = await noticeWorkChanges(runtime, chatDirectory);
  assert.equal(notice?.change, 'failed');
  assert.match(notice!.text, /failed: MessageAbortedError: Aborted \(a hire ran out its time limit/);
  assert.deepEqual(notice!.origin, { sessionID: 'ses_1', directory: '/desks/clippy' });
  assert.deepEqual(await noticeWorkChanges(runtime, chatDirectory), [], 'a change is noticed once');
  assert.equal((await pendingNotices(runtime)).length, 1);
  assert.equal(await claimNotice(runtime, notice!.id), true);
  assert.equal(await claimNotice(runtime, notice!.id), false, 'only one server delivers');
  assert.equal((await pendingNotices(runtime)).length, 0);

  const published = { ...item, status: 'landed' as const, branch: 'owners/x', publication: { url: 'https://github.com/x/y/pull/1', branch: 'owners/x', by: 'p', at: '', state: 'open' as const } };
  assert.match(describeChange(published, 'reviewing|')!.text, /published as https:\/\/github.com\/x\/y\/pull\/1/);
  assert.equal(describeChange({ ...published, publication: { ...published.publication, state: 'merged' } }, 'landed|open')?.change, 'pr-merged');
  assert.equal(describeChange(published, 'landed|open'), undefined);
});

test('an owner reads its charter as the person wrote it now', async () => {
  const { mkdtemp: temp, readFile: read } = await import('node:fs/promises');
  const { Notebook } = await import('@onionsoup/owners');
  const root = await temp(join(tmpdir(), 'owners-charter-'));
  let charter = '# Charter: v1\n\n- the person merges\n';
  const notebook = new Notebook(root, 'leto', async () => charter);
  await notebook.ensure(charter);
  charter = '# Charter: v2\n\n- Leto merges under his grant\n';
  assert.match(await notebook.orientation(), /Leto merges under his grant/);
  assert.doesNotMatch(await notebook.orientation(), /the person merges/);
  assert.doesNotMatch(await notebook.orientation(), /<<MAP\.md>>/, 'an empty register is left out');
  await notebook.ensure(charter);
  assert.match(await read(join(root, 'leto', 'CHARTER.md'), 'utf8'), /v2/, 'the copy follows the person\'s edits');

});

test('long work runs beside the tick: once per key, within a cap, and a CLI tick can wait for it', async () => {
  const { Background } = await import('@onionsoup/owners');
  const background = new Background(2);
  const finish: (() => void)[] = [];
  const job = () => new Promise<void>(resolve => finish.push(resolve));
  assert.equal(background.start('leto/w-1', job), true);
  assert.equal(background.start('leto/w-1', job), false, 'the same item never runs twice at once');
  assert.equal(background.start('murbella/w-2', job), true);
  assert.equal(background.start('clippy/w-3', job), false, 'the cap holds');
  assert.deepEqual(background.keys(), ['leto/w-1', 'murbella/w-2']);
  let drained = false;
  const waiting = background.drain().then(() => { drained = true; });
  finish.forEach(resolve => resolve());
  await waiting;
  assert.equal(drained, true);
  assert.equal(background.size, 0);
  assert.equal(background.start('clippy/w-3', async () => { throw new Error('a failing job frees its slot'); }), true);
  await background.drain();
  assert.equal(background.size, 0);
});

test('notebook commits from work running side by side queue instead of colliding', async () => {
  const { Notebook } = await import('@onionsoup/owners');
  const { execFileSync } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'owners-commits-'));
  const books = ['leto', 'odrade', 'murbella'].map(owner => new Notebook(root, owner));
  for (const book of books) await book.ensure('# Charter\n');
  await Promise.all(books.flatMap(book => [1, 2, 3].map(async index => {
    await book.journal({ kind: 'test', note: `entry ${index}` });
    await book.commit(`entry ${index}`);
  })));
  assert.equal(execFileSync('git', ['-C', root, 'status', '--porcelain']).toString(), '', 'everything was committed');
});

/** Sets ONIONSOUP_HOME to a fresh directory for the duration of one test, and restores it after. */
async function withPrivateHome<T>(run: () => Promise<T> | T): Promise<T> {
  const previous = process.env.ONIONSOUP_HOME;
  process.env.ONIONSOUP_HOME = await mkdtemp(join(tmpdir(), 'owners-sandbox-home-'));
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.ONIONSOUP_HOME;
    else process.env.ONIONSOUP_HOME = previous;
  }
}

test('a hostile caller environment cannot override the private opencode config and state paths', async () => {
  await withPrivateHome(async () => {
    const { sandboxEnvironment, privateXdgRoots } = await import('../src/sandbox.ts');
    const { config, state } = privateXdgRoots();
    const previousInherited = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR };
    process.env.XDG_CONFIG_HOME = '/host/inherited-config';
    process.env.XDG_STATE_HOME = '/host/inherited-state';
    process.env.OPENCODE_CONFIG_DIR = '/host/inherited-opencode-config';
    try {
      const environment = sandboxEnvironment({ XDG_CONFIG_HOME: '/caller/hostile-config', XDG_STATE_HOME: '/caller/hostile-state', OPENCODE_CONFIG_DIR: '/caller/hostile-opencode-config' });
      assert.equal(environment.XDG_CONFIG_HOME, config, 'the private root wins over a hostile caller value');
      assert.equal(environment.XDG_STATE_HOME, state, 'the private root wins over a hostile caller value');
      assert.equal(environment.OPENCODE_CONFIG_DIR, join(config, 'opencode'), 'the private root wins over a hostile caller value');
    } finally {
      for (const [key, value] of Object.entries(previousInherited)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

test('a caller-supplied OPENCODE_CONFIG_CONTENT survives sandboxEnvironment even while hostile protected paths do not', async () => {
  await withPrivateHome(async () => {
    const { sandboxEnvironment, privateXdgRoots } = await import('../src/sandbox.ts');
    const { config } = privateXdgRoots();
    const agentConfig = JSON.stringify({ plugin: ['file:///onionsoup/plugin.js'] });
    const environment = sandboxEnvironment({
      OPENCODE_CONFIG_CONTENT: agentConfig,
      OPENCODE_CONFIG_DIR: '/caller/hostile-opencode-config',
    });
    assert.equal(environment.OPENCODE_CONFIG_CONTENT, agentConfig, 'a hire\'s own per-session agent config must reach the sandboxed opencode');
    assert.equal(environment.OPENCODE_CONFIG_DIR, join(config, 'opencode'), 'the private root still wins over a hostile caller path');
  });
});

test('a sandboxed command binds private config/state and legitimate caches, never the masked host paths, with masks last', async () => {
  await withPrivateHome(async () => {
    const { sandboxCommand, privateXdgRoots, MASKED_HOST_PATHS } = await import('../src/sandbox.ts');
    const { config, state } = privateXdgRoots();
    const findingsDirectory = join(homedir(), 'a-findings-directory');
    const args = sandboxCommand('true', [], { cwd: '/tmp', writable: [findingsDirectory] });
    const writableBinds: string[] = [];
    for (let index = 0; index < args.length - 2; index += 1) {
      if (args[index] === '--bind-try') writableBinds.push(args[index + 2]!);
    }
    for (const path of [config, state, join(homedir(), '.cache'), join(homedir(), '.npm'), join(homedir(), 'go'), findingsDirectory]) {
      assert.ok(writableBinds.includes(path), `${path} should be a writable bind`);
    }
    for (const masked of MASKED_HOST_PATHS) assert.ok(!writableBinds.includes(masked), `${masked} must never be a writable bind`);

    const lastBindIndex = args.lastIndexOf('--bind-try');
    const firstMaskIndex = args.indexOf('--tmpfs', lastBindIndex);
    assert.ok(firstMaskIndex > lastBindIndex, 'every writable bind must come before the host config/state masks');
    for (const masked of MASKED_HOST_PATHS) {
      const maskIndex = args.indexOf(masked);
      assert.equal(args[maskIndex - 1], '--tmpfs');
      assert.ok(maskIndex > lastBindIndex, `${masked} must be masked after the last writable bind`);
    }
  });
});

test('a writable path that equals, contains or is contained by a masked host path is rejected; a sibling is not', async () => {
  await withPrivateHome(async () => {
    const { sandboxCommand } = await import('../src/sandbox.ts');
    const masked = join(homedir(), '.config/opencode');
    const attempt = (path: string) => () => sandboxCommand('true', [], { cwd: '/tmp', writable: [path] });
    assert.throws(attempt(masked), /writable_path_masks_host_opencode/, 'the exact masked path is rejected');
    assert.throws(attempt(join(homedir(), '.config')), /writable_path_masks_host_opencode/, 'a covering ancestor is rejected');
    assert.throws(attempt(`${masked}/`), /writable_path_masks_host_opencode/, 'a trailing slash cannot bypass the mask');
    assert.throws(attempt(join(homedir(), '.config/foo/../opencode')), /writable_path_masks_host_opencode/, 'a ".." segment cannot bypass the mask');
    assert.doesNotThrow(attempt(join(homedir(), '.config/opencode2')), 'a sibling name must not be rejected');
  });
});

test('a sandboxed npm ci succeeds in a minimal fixture, with private XDG roots and the worktree writable', async () => {
  await withPrivateHome(async () => {
    const { runSandboxed, privateXdgRoots } = await import('../src/sandbox.ts');
    const { writeFile, readFile } = await import('node:fs/promises');
    // A minimal package + lockfile with no dependencies: fast, network-free, and it still exercises a real
    // npm binary running inside bwrap.
    const fixture = await mkdtemp(join(tmpdir(), 'owners-npmci-'));
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'onionsoup-sandbox-fixture', version: '0.0.0', private: true }));
    await writeFile(join(fixture, 'package-lock.json'), JSON.stringify({
      name: 'onionsoup-sandbox-fixture', version: '0.0.0', lockfileVersion: 3, requires: true,
      packages: { '': { name: 'onionsoup-sandbox-fixture', version: '0.0.0' } },
    }));
    const result = await runSandboxed('npm', ['ci', '--no-audit', '--no-fund'], { cwd: fixture, writable: [fixture] });
    assert.equal(result.exitCode, 0, result.output);
    // Have the sandbox itself write a marker, then read it back on the host: proves the worktree bind
    // is really writable from inside bwrap, not merely readable through the read-only root bind.
    const written = await runSandboxed('sh', ['-c', 'echo sandbox-wrote-this > sandbox-wrote-here.txt'], { cwd: fixture, writable: [fixture] });
    assert.equal(written.exitCode, 0, written.output);
    assert.equal((await readFile(join(fixture, 'sandbox-wrote-here.txt'), 'utf8')).trim(), 'sandbox-wrote-this');

    // The private XDG roots must be writable too, not merely pointed to by an env var: this is the exact
    // failure the previous attempt shipped (paths configured but never bound, so every sandboxed process broke).
    const { config, state } = privateXdgRoots();
    const probe = await runSandboxed('sh', ['-c', `echo config-ok > "$0/probe.txt" && echo state-ok > "$1/probe.txt"`, config, state], { cwd: fixture, writable: [fixture] });
    assert.equal(probe.exitCode, 0, probe.output);
    assert.equal((await readFile(join(config, 'probe.txt'), 'utf8')).trim(), 'config-ok');
    assert.equal((await readFile(join(state, 'probe.txt'), 'utf8')).trim(), 'state-ok');
  });
});

test('PLUGIN_URL resolves to an existing sibling plugin from source, and agentConfig loads it explicitly', async () => {
  const { PLUGIN_URL: sourceUrl, agentConfig } = await import('../src/opencode.ts');
  assert.match(sourceUrl, /plugin\.ts$/);
  await assert.doesNotReject(import('node:fs/promises').then(fs => fs.access(new URL(sourceUrl))));
  // Removing `plugin: [PLUGIN_URL]` from agentConfig would leave the host's now-masked global config as the
  // sandboxed server's only source of plugins: assert the real per-hire config actually carries it.
  assert.deepEqual(agentConfig('/tmp', '/tmp', undefined).plugin, [sourceUrl]);
});

test("every hire role reads env-named files without asking, since nobody can answer a hire's question", async () => {
  const { agentConfig } = await import('../src/opencode.ts');
  const agents = agentConfig('/tmp', '/tmp', '/tmp/notes/findings.md').agent;
  for (const [name, agent] of Object.entries(agents)) {
    assert.deepEqual(agent.permission.read, { '*': 'allow', '*.env': 'allow', '*.env.*': 'allow' }, name);
  }
});

test('a permission question raised inside a hire is rejected at once with a reason the model can read', async () => {
  const { rejectPendingPermissions } = await import('../src/opencode.ts');
  const replies: { requestID: string; reply: string; message?: string }[] = [];
  const pending = [{ id: 'per_1', permission: 'read', patterns: ['templates/coder.env.j2'] }];
  const client = {
    permission: {
      list: async () => ({ data: pending.splice(0) }),
      reply: async (options: { requestID: string; reply: string; message?: string }) => {
        replies.push(options);
        return { data: true };
      },
    },
  } as unknown as Parameters<typeof rejectPendingPermissions>[0];
  await rejectPendingPermissions(client, '/tmp', 'w-1: review 1');
  await rejectPendingPermissions(client, '/tmp', 'w-1: review 1');
  assert.equal(replies.length, 1, 'each question is answered once');
  assert.equal(replies[0]!.reply, 'reject');
  assert.match(replies[0]!.message!, /^permission_needs_person: read templates\/coder\.env\.j2\./);
});

test('the built plugin.js exists next to the built opencode.js, and its agentConfig loads it explicitly', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)('npm', ['run', 'build'], { cwd: join(import.meta.dirname, '..', '..', '..') });
  const distUrl = new URL('../dist/opencode.js', import.meta.url);
  const { PLUGIN_URL: builtUrl, agentConfig: builtAgentConfig } = await import(distUrl.href) as {
    PLUGIN_URL: string;
    agentConfig: (worktree: string, directory: string, notesFile: string | undefined) => { plugin: string[] };
  };
  assert.match(builtUrl, /plugin\.js$/);
  await assert.doesNotReject(import('node:fs/promises').then(fs => fs.access(new URL(builtUrl))));
  assert.deepEqual(builtAgentConfig('/tmp', '/tmp', undefined).plugin, [builtUrl]);
});

/**
 * The real sandbox and paid-hire smoke test: proves — deterministically, through `runSandboxed` itself, not
 * a model's self-report — that a sandboxed process cannot read a host-config sentinel and cannot create a
 * file in the host's real opencode config directory, then completes a real planner hire through the
 * explicitly loaded plugin. It needs a real bwrap sandbox and a paid model call, so it is opt-in and skipped
 * by default. A person (or the owner, from an unsandboxed shell) runs it once by hand before shipping this
 * change, the same shape as the ship action's person-approval gate; this is not evidence the implementer or
 * reviewer loop can produce or corroborate.
 */
test('a sandboxed process cannot read or write the host opencode config, and a real hire still completes through the explicit plugin (opt-in, needs ONIONSOUP_REAL_SANDBOX_SMOKE=1 and a paid model)', { skip: process.env.ONIONSOUP_REAL_SANDBOX_SMOKE !== '1' && 'set ONIONSOUP_REAL_SANDBOX_SMOKE=1 and run by hand before shipping' }, async () => {
  const { writeFile, rm, access, mkdir } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  const { runSandboxed } = await import('../src/sandbox.ts');
  const { homeDirectory } = await import('../src/paths.ts');
  const { Freelancers } = await import('../src/opencode.ts');
  const hostConfigDirectory = join(homedir(), '.config/opencode');
  const sentinelPath = join(hostConfigDirectory, 'onionsoup-smoke-sentinel.txt');
  const writeAttemptPath = join(hostConfigDirectory, 'onionsoup-smoke-write-attempt.txt');
  const sentinel = randomUUID();
  // Fail loudly, not silently, if the fixture itself cannot be created: a caught write here would let this
  // test pass even though it never proved anything.
  await writeFile(sentinelPath, sentinel);
  await rm(writeAttemptPath, { force: true });
  const scratch = await mkdtemp(join(tmpdir(), 'owners-smoke-scratch-'));
  try {
    // Deterministic probes first: a real sandboxed command tries to read the sentinel and tries to create a
    // file in the host config directory. No model is asked to self-report either result.
    const readAttempt = await runSandboxed('sh', ['-c', `cat "$0" > "$1/read-attempt.txt" 2>&1 || true`, sentinelPath, scratch], { cwd: scratch, writable: [scratch] });
    assert.equal(readAttempt.exitCode, 0, readAttempt.output);
    const { readFile } = await import('node:fs/promises');
    const readOutput = await readFile(join(scratch, 'read-attempt.txt'), 'utf8').catch(() => '');
    assert.doesNotMatch(readOutput, new RegExp(sentinel), 'the sandbox must not be able to read the host config sentinel');

    const writeAttempt = await runSandboxed('sh', ['-c', `echo written-from-sandbox > "$0"`, writeAttemptPath], { cwd: scratch, writable: [scratch] });
    assert.notEqual(writeAttempt.exitCode, 0, 'writing into the masked host opencode config directory must fail from inside the sandbox');
    await assert.rejects(access(writeAttemptPath), 'the sandbox must not have created a file in the host opencode config directory');

    // Only after the deterministic proof: complete a real hire through the explicitly loaded plugin.
    const freelancers = await Freelancers.start();
    // Under ONIONSOUP_HOME, not host /tmp: the sandbox masks /tmp with its own --tmpfs, so a directory that
    // is not itself a writable bind (host /tmp included) is invisible inside bwrap and --chdir fails.
    const sessionRoot = join(homeDirectory(), 'sandbox-smoke-sessions');
    await mkdir(sessionRoot, { recursive: true });
    const directory = await mkdtemp(join(sessionRoot, 'owners-smoke-'));
    const result = await freelancers.hire({
      role: 'reviewer',
      model: process.env.ONIONSOUP_REAL_SANDBOX_SMOKE_MODEL ?? 'github-copilot/claude-sonnet-5',
      directory,
      title: 'sandbox smoke',
      brief: 'Say "isolated" in the "summary" field and nothing else.',
      schema: (await import('zod')).z.object({ summary: (await import('zod')).z.string() }),
    });
    assert.match(result.value.summary, /isolated/i, 'a real reviewer hire must still complete through the explicitly loaded plugin');
  } finally {
    await rm(sentinelPath, { force: true });
    await rm(writeAttemptPath, { force: true });
  }
});

test('resolving a rebase conflict stages only the conflicted and reported files, leaving anything else and reporting it', async () => {
  const { execFileSync } = await import('node:child_process');
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { stageConflictResolution } = await import('../src/rebase.ts');
  const root = await mkdtemp(join(tmpdir(), 'owners-rebase-conflict-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).toString();
  git('init', '-q', '-b', 'main');
  await writeFile(join(root, 'conflict.txt'), 'line1\n');
  await writeFile(join(root, 'package-lock.json'), '{"version": 1}\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('checkout', '-qb', 'feature');
  await writeFile(join(root, 'conflict.txt'), 'line1\nfeature-change\n');
  git('add', '-A');
  git('commit', '-qm', 'feature change');
  const featureSha = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', 'main');
  await writeFile(join(root, 'conflict.txt'), 'line1\nmain-change\n');
  git('add', '-A');
  git('commit', '-qm', 'main change');
  assert.throws(() => git('cherry-pick', featureSha), /error: could not apply/);
  assert.match(git('status', '--porcelain'), /^UU conflict\.txt$/m, 'stopped mid cherry-pick on the expected conflict');

  // The implementer resolves the conflict, but also leaves an npm-regenerated lockfile and a scratch directory behind.
  await writeFile(join(root, 'conflict.txt'), 'line1\nfeature-change\nmain-change\n');
  await writeFile(join(root, 'package-lock.json'), '{"version": 2}\n');
  await mkdir(join(root, 'wt'));
  await writeFile(join(root, 'wt', 'scratch.txt'), 'not part of the change\n');

  const { staged, leftovers } = await stageConflictResolution(root, ['conflict.txt'], []);
  assert.deepEqual(staged, ['conflict.txt'], 'only the conflicted file is staged');
  assert.deepEqual(leftovers.sort(), ['package-lock.json', 'wt/'], 'the lockfile and scratch directory are reported, not staged');
  assert.equal(git('diff', '--cached', '--name-only').trim(), 'conflict.txt', 'only the conflicted file is in the index');

  git('-c', 'core.editor=true', 'cherry-pick', '--continue');
  const committed = git('show', '--stat', '--format=', 'HEAD').trim().split('\n')[0]?.trim();
  assert.equal(committed, 'conflict.txt | 1 +', 'the continued cherry-pick commits only the conflicted file');
  assert.equal(git('status', '--porcelain').trim(), ' M package-lock.json\n?? wt/'.trim(), 'the lockfile and scratch directory remain, uncommitted');
});

test('resolving a rebase conflict also stages paths the implementer reports it touched', async () => {
  const { execFileSync } = await import('node:child_process');
  const { writeFile } = await import('node:fs/promises');
  const { stageConflictResolution } = await import('../src/rebase.ts');
  const root = await mkdtemp(join(tmpdir(), 'owners-rebase-conflict-reported-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).toString();
  git('init', '-q', '-b', 'main');
  await writeFile(join(root, 'conflict.txt'), 'line1\n');
  await writeFile(join(root, 'helper.ts'), 'export const x = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  await writeFile(join(root, 'conflict.txt'), 'line1\nresolved\n');
  await writeFile(join(root, 'helper.ts'), 'export const x = 2;\n');
  await writeFile(join(root, 'unrelated.txt'), 'left behind\n');

  const { staged, leftovers } = await stageConflictResolution(root, ['conflict.txt'], ['helper.ts']);
  assert.deepEqual(staged.sort(), ['conflict.txt', 'helper.ts']);
  assert.deepEqual(leftovers, ['unrelated.txt']);
  assert.equal(git('diff', '--cached', '--name-only').trim().split('\n').sort().join(','), 'conflict.txt,helper.ts');
});

test('a filename with pathspec metacharacters or a leading dash is staged literally, never expanded', async () => {
  const { execFileSync } = await import('node:child_process');
  const { writeFile } = await import('node:fs/promises');
  const { stageConflictResolution } = await import('../src/rebase.ts');
  const root = await mkdtemp(join(tmpdir(), 'owners-rebase-conflict-literal-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).toString();
  git('init', '-q', '-b', 'main');
  await writeFile(join(root, 'weird[a]star.txt'), 'line1\n');
  await writeFile(join(root, '-dash.txt'), 'line1\n');
  await writeFile(join(root, 'decoy.txt'), 'unrelated tracked file that a broadened glob could match\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  await writeFile(join(root, 'weird[a]star.txt'), 'resolved\n');
  await writeFile(join(root, '-dash.txt'), 'resolved\n');
  await writeFile(join(root, 'decoy.txt'), 'should remain untouched\n');

  const { staged, leftovers } = await stageConflictResolution(root, ['weird[a]star.txt', '-dash.txt'], []);
  assert.deepEqual(staged.sort(), ['-dash.txt', 'weird[a]star.txt']);
  assert.deepEqual(leftovers, ['decoy.txt'], 'the tracked decoy that a broadened pathspec could have matched is left out');
  assert.equal(git('diff', '--cached', '--name-only').trim().split('\n').sort().join(','), '-dash.txt,weird[a]star.txt');
});

test('a non-conflicting change git already staged mid cherry-pick is not reported as a leftover', async () => {
  const { execFileSync } = await import('node:child_process');
  const { writeFile } = await import('node:fs/promises');
  const { stageConflictResolution } = await import('../src/rebase.ts');
  const root = await mkdtemp(join(tmpdir(), 'owners-rebase-conflict-partial-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).toString();
  git('init', '-q', '-b', 'main');
  await writeFile(join(root, 'conflict.txt'), 'line1\n');
  await writeFile(join(root, 'clean.txt'), 'line1\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('checkout', '-qb', 'feature');
  await writeFile(join(root, 'conflict.txt'), 'line1\nfeature-change\n');
  await writeFile(join(root, 'clean.txt'), 'line1\nfeature-change\n');
  git('add', '-A');
  git('commit', '-qm', 'feature change');
  const featureSha = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', 'main');
  await writeFile(join(root, 'conflict.txt'), 'line1\nmain-change\n');
  git('add', '-A');
  git('commit', '-qm', 'main change');
  assert.throws(() => git('cherry-pick', featureSha), /error: could not apply/);
  // git already auto-merged and staged clean.txt as part of the cherry-pick; only conflict.txt stopped it.
  assert.match(git('status', '--porcelain'), /^M {2}clean\.txt$/m, 'the non-conflicting change is already staged');

  await writeFile(join(root, 'conflict.txt'), 'line1\nfeature-change\nmain-change\n');
  const { staged, leftovers } = await stageConflictResolution(root, ['conflict.txt'], []);
  assert.deepEqual(staged, ['conflict.txt']);
  assert.deepEqual(leftovers, [], 'the already-staged non-conflicting change is not reported as left out');

  git('-c', 'core.editor=true', 'cherry-pick', '--continue');
  const committedFiles = git('diff', '--name-only', 'HEAD~1', 'HEAD').trim().split('\n').sort();
  assert.deepEqual(committedFiles, ['clean.txt', 'conflict.txt'], 'the non-conflicting staged change is committed along with the conflict resolution');
});
