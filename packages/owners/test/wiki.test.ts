import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Plugin } from '@opencode-ai/plugin';
import { recentJournal } from '../src/chat-context.ts';
import { loadDeclarations } from '../src/declarations.ts';
import { listAttention } from '../src/attention.ts';
import { WIKI_DELETE_PERMISSION, WIKI_LIMITS } from '../src/wiki.ts';
import { MIGRATION_REASON, migrateNav } from '../src/wiki-migrate.ts';
import { parsePage, type WikiNode } from '../src/wiki-pages.ts';
import { withActiveHooks } from './active-hooks.ts';
import { configWith, gitIn, HOMEWIKI, pushElsewhere, remoteFile, remoteHead, wikiRuntime, wikiYaml } from './wiki-fixture.ts';

const BELLONDA = 'Bellonda <bellonda@onionsoup>';

function overrideLimit(context: TestContext, key: keyof typeof WIKI_LIMITS, value: number) {
  const previous = WIKI_LIMITS[key];
  context.after(() => { WIKI_LIMITS[key] = previous; });
  WIKI_LIMITS[key] = value;
}

async function wikiKinds(runtime: Awaited<ReturnType<typeof wikiRuntime>>['runtime'], kind: string) {
  return (await recentJournal(runtime, 'bellonda')).filter(entry => entry.kind === kind);
}

/** Titles in sidebar order, depth first, sections marked with a slash. */
function flatTitles(nodes: readonly WikiNode[]): string[] {
  return nodes.flatMap(node => node.kind === 'page' ? [node.title] : [`${node.title}/`, ...flatTitles(node.children)]);
}

test('wiki.yaml is optional; it parses with defaults, and a keeper who is not a declared owner is refused', async () => {
  assert.equal((await loadDeclarations('packages/owners/test/fixtures/owners')).wiki, undefined, 'no file, no wiki');
  assert.equal((await loadDeclarations(await configWith({ 'wiki.yaml': '# repository: git@github.com:me/wiki.git\n' }))).wiki, undefined, 'only comments, no wiki');
  const wiki = (await loadDeclarations(await configWith({ 'wiki.yaml': 'repository: git@github.com:me/wiki.git\nlisten: 0.0.0.0:4748\nkeeper: bellonda\n' }))).wiki;
  assert.deepEqual(wiki, { repository: 'git@github.com:me/wiki.git', branch: 'main', pagesDirectory: 'docs', listen: { host: '0.0.0.0', port: 4748 }, keeper: 'bellonda' });
  await assert.rejects(loadDeclarations(await configWith({ 'wiki.yaml': wikiYaml('/tmp/wiki.git', 'chani') })), /^Error: wiki_keeper_unknown: wiki\.yaml names chani/);
  await assert.rejects(loadDeclarations(await configWith({ 'wiki.yaml': 'repository: r\nlisten: 4748\nkeeper: bellonda\n' })), /wiki_invalid: wiki\.yaml: listen/);
  await assert.rejects(loadDeclarations(await configWith({ 'wiki.yaml': 'repository: r\nlisten: a:1\nkeeper: bellonda\npagesDirectory: ../x\n' })), /wiki_invalid: wiki\.yaml: pagesDirectory/);
});

test('a write commits as the keeper with the reason as subject, pushes, and journals', async () => {
  const { runtime, wiki, remote } = await wikiRuntime(HOMEWIKI);
  const content = '---\ntitle: Caddy\norder: 40\nsources: [caddy host]\nowner: bellonda\n---\n# Caddy\n\nCaddy terminates TLS for every service.\n';
  const change = await wiki.write('bellonda', 'hosts/caddy.md', content, 'Record how Caddy fronts services');
  assert.equal(change.outcome, 'pushed');
  assert.equal(await remoteHead(remote), `${BELLONDA}|Record how Caddy fronts services`);
  assert.equal(await remoteFile(remote, 'docs/hosts/caddy.md'), content.trimEnd());
  assert.equal(change.commit, await gitIn(remote, 'rev-parse', 'main'));
  const [journaled] = await wikiKinds(runtime, 'wiki-write');
  assert.equal(journaled?.note, 'Record how Caddy fronts services');
  assert.match(String(journaled?.outcome), /^hosts\/caddy\.md at [0-9a-f]{12}$/);
  const page = await wiki.read('docs/hosts/caddy.md');
  assert.deepEqual(page.frontmatter, { title: 'Caddy', order: 40, sources: ['caddy host'], owner: 'bellonda' }, 'unknown fields are kept');
  assert.equal((await wiki.write('bellonda', 'hosts/caddy.md', content, 'Again')).outcome, 'unchanged', 'the same text commits nothing');
});

test('escaping paths, oversized pages, secrets and non-keepers are refused with their codes, and nothing is committed', async context => {
  const { wiki, remote } = await wikiRuntime(HOMEWIKI);
  await wiki.ensureClone();
  const before = await remoteHead(remote);
  const write = (path: string, content: string, by = 'bellonda') => wiki.write(by, path, content, 'Try it');
  for (const path of ['../secrets.md', 'hosts/../../mkdocs.md', '/etc/passwd.md', 'notes.txt', 'docs/', '']) {
    await assert.rejects(write(path, '# x\n'), /^Error: wiki_path_invalid/, path);
  }
  await assert.rejects(write('network.md', '# x\n', 'homelab'), /^Error: wiki_not_keeper: only bellonda writes the wiki/);
  await assert.rejects(write('network.md', '# x\n', 'operator'), /^Error: wiki_not_keeper/);
  const secrets = [
    'The key is sk-proj-abcdefghijklmnopqrstuvwx.',
    'token: ghp_0123456789abcdefghijABCDEFGHIJ012345',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----',
  ];
  for (const secret of secrets) await assert.rejects(write('network.md', `# Network\n\n${secret}\n`), /^Error: wiki_secret_detected/, secret);
  await assert.rejects(wiki.write('bellonda', 'network.md', '# fine\n', 'rotate github_pat_11ABCDEFG0123456789_abcdef'), /wiki_secret_detected: .*githubToken/);
  await assert.rejects(write('network.md', '---\norder: first\n---\n# x\n'), /^Error: wiki_frontmatter_invalid: order/);
  await assert.rejects(wiki.write('bellonda', 'network.md', '# x\n', 'two\nlines'), /^Error: wiki_reason_invalid/);
  overrideLimit(context, 'pageBytes', 64);
  await assert.rejects(write('network.md', `# Network\n\n${'x'.repeat(80)}\n`), /^Error: wiki_page_too_large: network\.md is \d+ bytes; at most 64/);
  assert.equal(await remoteHead(remote), before, 'the remote is untouched');
  assert.equal(await gitIn(wiki.directory, 'log', '-1', '--format=%s'), 'Seed the wiki', 'no local commit either');
  assert.equal(await gitIn(wiki.directory, 'status', '--porcelain'), '', 'and nothing written');
});

test('prose that looks like a digest, a URL or a bearer example is not a secret', async () => {
  const { wiki } = await wikiRuntime(HOMEWIKI);
  const prose = '# Notes\n\nImage sha256:0123456789abcdef0123456789abcdef0123456789abcdef at https://github.com/bketelsen/homewiki/blob/main/docs/network.md.\n\n`curl -H "Authorization: Bearer $TOKEN"`\n';
  assert.equal((await wiki.write('bellonda', 'notes.md', prose, 'Keep notes')).outcome, 'pushed');
});

test('a push the remote refused because it moved is rebased and pushed', async () => {
  const { wiki, remote } = await wikiRuntime(HOMEWIKI);
  await wiki.ensureClone();
  await pushElsewhere(remote, { 'docs/storage.md': '# Storage\n\nPools changed elsewhere.\n' }, 'Edit storage elsewhere');
  const change = await wiki.write('bellonda', 'network.md', '# Network\n\nThe UDM Pro routes 10.0.2.0/24 now.\n', 'Correct the subnet');
  assert.equal(change.outcome, 'pushed');
  assert.equal(await remoteHead(remote), `${BELLONDA}|Correct the subnet`);
  assert.deepEqual((await gitIn(remote, 'log', '--format=%s', 'main')).split('\n'), ['Correct the subnet', 'Edit storage elsewhere', 'Seed the wiki']);
  assert.match(await readFile(join(wiki.pagesRoot, 'storage.md'), 'utf8'), /changed elsewhere/, 'the clone has the other change too');
});

test('a conflicting remote change gives wiki_push_conflict, keeps the local commit and raises attention', async () => {
  const { runtime, wiki, remote } = await wikiRuntime(HOMEWIKI);
  await wiki.ensureClone();
  await pushElsewhere(remote, { 'docs/network.md': '# Network\n\nRouted by something else.\n' }, 'Edit network elsewhere');
  await assert.rejects(
    wiki.write('bellonda', 'network.md', '# Network\n\nRouted by the UDM Pro, on 10.0.2.0/24.\n', 'Correct the subnet'),
    /^Error: wiki_push_conflict: the remote changed the same lines; the commit is kept in /,
  );
  assert.equal(await remoteHead(remote), 'Seed <seed@example.invalid>|Edit network elsewhere', 'the remote keeps its change');
  assert.equal(await gitIn(wiki.directory, 'log', '-1', '--format=%an <%ae>|%s'), `${BELLONDA}|Correct the subnet`, 'the local commit is kept');
  assert.equal(await gitIn(wiki.directory, 'status', '--porcelain'), '', 'no rebase is left half done');
  assert.match(await readFile(join(wiki.pagesRoot, 'network.md'), 'utf8'), /10\.0\.2\.0/, 'the content is not lost');
  const [journaled] = await wikiKinds(runtime, 'wiki-write');
  assert.match(String(journaled?.outcome), /kept locally, not pushed/);
  const attention = (await listAttention(runtime)).filter(entry => entry.owner === 'bellonda');
  assert.match(attention[0]?.note ?? '', /^wiki network\.md: wiki_push_conflict/);
});

test('list orders pages by order then title with the index first, and titles fall back to heading then file name', async () => {
  const { wiki } = await wikiRuntime({
    'docs/index.md': '---\norder: 99\n---\n# Home\n',
    'docs/zeta.md': '---\norder: 1\n---\n# Zeta first\n',
    'docs/alpha.md': '# Alpha\n',
    'docs/beta.md': '---\ntitle: Beta by frontmatter\n---\n# Ignored heading\n',
    'docs/plain.md': 'No heading here.\n',
    'docs/hosts/selfie.md': '---\norder: 5\n---\n# Selfie\n',
    'docs/hosts/caddy.md': '---\norder: 6\n---\n# Caddy\n',
    'docs/broken.md': '---\norder: [\n---\n# Broken frontmatter\n',
  });
  assert.deepEqual(flatTitles(await wiki.list()), [
    'Home', 'Zeta first', 'hosts/', 'Selfie', 'Caddy', 'Alpha', 'Beta by frontmatter', 'Broken frontmatter', 'plain',
  ]);
  const broken = await wiki.read('broken.md');
  assert.match(String(broken.frontmatterError), /^wiki_frontmatter_invalid/);
  await assert.rejects(wiki.read('missing.md'), /^Error: wiki_page_not_found: missing\.md/);
});

test('move renames a page and journals it; a missing source or an existing target is refused', async () => {
  const { runtime, wiki, remote } = await wikiRuntime(HOMEWIKI);
  const change = await wiki.move('bellonda', 'hosts/minideb.md', 'hosts/coder.md', 'Name the page after what it runs');
  assert.equal(change.path, 'hosts/coder.md');
  assert.equal(await remoteHead(remote), `${BELLONDA}|Name the page after what it runs`);
  assert.equal(await remoteFile(remote, 'docs/hosts/coder.md'), 'Minideb runs Coder.');
  await assert.rejects(remoteFile(remote, 'docs/hosts/minideb.md'));
  assert.equal((await wikiKinds(runtime, 'wiki-move'))[0]?.note, 'Name the page after what it runs');
  await assert.rejects(wiki.move('bellonda', 'hosts/minideb.md', 'x.md', 'Again'), /^Error: wiki_page_not_found/);
  await assert.rejects(wiki.move('bellonda', 'network.md', 'storage.md', 'Clobber'), /^Error: wiki_page_exists: storage\.md/);
  assert.deepEqual((await wiki.history('hosts/coder.md')).map(entry => entry.subject), ['Name the page after what it runs', 'Seed the wiki'], 'history follows the move');
});

test('search ranks pages, history lists commits, and backlinks find linking pages', async context => {
  const { wiki } = await wikiRuntime(HOMEWIKI);
  const hits = await wiki.search('selfie gpu');
  assert.equal(hits[0]?.path, 'hosts/selfie.md', 'the page matching every term, in its title too, ranks first');
  assert.ok(hits.some(hit => hit.path === 'index.md'));
  assert.match(hits[0]!.snippet, /GPU/i);
  overrideLimit(context, 'searchResults', 1);
  assert.equal((await wiki.search('selfie')).length, 1, 'results are capped');
  await assert.rejects(wiki.search('   '), /^Error: wiki_query_empty/);
  await wiki.write('bellonda', 'network.md', '# Network\n\nNew subnet.\n', 'Correct the subnet');
  const history = await wiki.history('network.md');
  assert.deepEqual(history.map(entry => [entry.author, entry.subject]), [['Bellonda', 'Correct the subnet'], ['Seed', 'Seed the wiki']]);
  assert.match(history[0]!.sha, /^[0-9a-f]{40}$/);
  assert.ok(!Number.isNaN(Date.parse(history[0]!.date)));
  overrideLimit(context, 'historyEntries', 1);
  assert.equal((await wiki.history('network.md')).length, 1, 'history is capped');
  assert.deepEqual((await wiki.backlinks('hosts/selfie.md')).map(entry => entry.path).sort(), ['index.md', 'storage.md']);
  assert.deepEqual((await wiki.backlinks('storage.md')).map(entry => entry.path), ['hosts/selfie.md'], 'relative ../ links resolve');
});

test('migrate moves the nav order into frontmatter, removes mkdocs.yml and pushes', async () => {
  const { runtime, wiki, remote } = await wikiRuntime(HOMEWIKI);
  const migration = await migrateNav(wiki);
  assert.deepEqual(migration.ordered, ['index.md', 'network.md', 'storage.md', 'hosts/selfie.md', 'hosts/minideb.md', 'services.md']);
  assert.deepEqual(migration.missing, []);
  assert.equal(await remoteHead(remote), `${BELLONDA}|${MIGRATION_REASON}`);
  await assert.rejects(remoteFile(remote, 'mkdocs.yml'), 'mkdocs.yml is gone from the remote');
  const frontmatter = async (path: string) => parsePage(await remoteFile(remote, `docs/${path}`)).frontmatter;
  assert.deepEqual(await frontmatter('index.md'), { order: 10 }, 'a nav title equal to the heading is not repeated');
  assert.deepEqual(await frontmatter('hosts/selfie.md'), { title: 'selfie', order: 40 }, 'a nav title that differs is kept');
  assert.deepEqual(await frontmatter('services.md'), { sources: ['truenas'], order: 60 }, 'existing fields stay');
  assert.match(await remoteFile(remote, 'docs/hosts/minideb.md'), /^---\norder: 50\n---\nMinideb runs Coder\.$/, 'a file-name title equal to the nav title is not repeated');
  assert.deepEqual(flatTitles(await wiki.list()), ['Homelab', 'Network', 'Storage', 'hosts/', 'selfie', 'minideb', 'Services']);
  assert.equal((await wikiKinds(runtime, 'wiki-write'))[0]?.note, MIGRATION_REASON);
  await assert.rejects(migrateNav(wiki), /^Error: wiki_migration_not_needed/);
});

function toolContext(agent: string, ask: (request: { permission: string; patterns: string[] }) => Promise<void> = async () => {}) {
  return {
    agent, sessionID: 'ses_chat', messageID: 'msg_1', directory: '/desk', worktree: '/desk',
    abort: new AbortController().signal, metadata: () => {}, ask,
  };
}

async function wikiHooks(files = HOMEWIKI) {
  const { runtime, wiki, remote, declarations, state } = await wikiRuntime(files, { 'operator.yaml': 'model: a/b\n' });
  const hooks = await withActiveHooks({} as Parameters<Plugin>[0], { declarations, state });
  const tool = hooks.tool!.onionsoup_wiki!;
  const call = (agent: string, args: Record<string, string>, ask?: Parameters<typeof toolContext>[1]) => tool.execute(args as never, toolContext(agent, ask) as never);
  return { runtime, wiki, remote, hooks, call };
}

test('onionsoup_wiki: any owner and the operator read; only the keeper writes', async () => {
  const { remote, call } = await wikiHooks();
  assert.match(String(await call('Miles Teg', { action: 'list' })), /^- Homelab \(index\.md\)\n- hosts\/\n {2}- minideb \(hosts\/minideb\.md\)\n {2}- Selfie \(hosts\/selfie\.md\)\n- Network/);
  assert.match(String(await call('Operator', { action: 'read', path: 'network.md' })), /^network\.md: Network\n\n# Network/);
  assert.match(String(await call('Operator', { action: 'search', query: 'caddy' })), /Services \(services\.md\)/);
  assert.match(String(await call('Operator', { action: 'backlinks', path: 'network.md' })), /Homelab \(index\.md\)/);
  assert.match(String(await call('Operator', { action: 'history', path: 'network.md' })), /Seed: Seed the wiki/);
  const before = await remoteHead(remote);
  await assert.rejects(call('Miles Teg', { action: 'write', path: 'network.md', content: '# x\n', reason: 'Mine now' }), /^Error: wiki_not_keeper/);
  await assert.rejects(call('Operator', { action: 'write', path: 'network.md', content: '# x\n', reason: 'Mine now' }), /^Error: wiki_not_keeper/);
  await assert.rejects(call('onionsoup-implementer', { action: 'list' }), /not one/);
  assert.equal(await remoteHead(remote), before);
  assert.match(String(await call('Bellonda', { action: 'write', path: 'network.md', content: '# Network\n\nUpdated.\n', reason: 'Update the network page' })), /^Committed [0-9a-f]{12} and pushed it to main: network\.md\./);
  await assert.rejects(call('Bellonda', { action: 'write', path: 'network.md', reason: 'No content' }), /^Error: wiki_argument_missing: content/);
});

test('onionsoup_wiki delete asks the person; a refusal keeps the page, an approval deletes and pushes', async () => {
  const { remote, call } = await wikiHooks();
  const asked: { permission: string; patterns: string[] }[] = [];
  const refuse = async (request: { permission: string; patterns: string[] }) => {
    asked.push(request);
    throw new Error('The user rejected permission to use this specific tool call with the following feedback: keep it');
  };
  await assert.rejects(call('Bellonda', { action: 'delete', path: 'hosts/minideb.md', reason: 'Retire minideb' }, refuse), /^Error: wiki_delete_denied: the person kept hosts\/minideb\.md: keep it/);
  assert.deepEqual(asked.map(request => [request.permission, request.patterns]), [[WIKI_DELETE_PERMISSION, ['hosts/minideb.md']]]);
  assert.equal(await remoteFile(remote, 'docs/hosts/minideb.md'), 'Minideb runs Coder.');
  await assert.rejects(call('Miles Teg', { action: 'delete', path: 'hosts/minideb.md', reason: 'x' }, refuse), /^Error: wiki_not_keeper/);
  assert.equal(asked.length, 1, 'a non-keeper never bothers the person');
  const approve = async (request: { permission: string; patterns: string[] }) => { asked.push(request); };
  assert.match(String(await call('Bellonda', { action: 'delete', path: 'hosts/minideb.md', reason: 'Retire minideb' }, approve)), /^Committed/);
  assert.equal(await remoteHead(remote), `${BELLONDA}|Retire minideb`);
  await assert.rejects(remoteFile(remote, 'docs/hosts/minideb.md'));
});

test('without wiki.yaml the tool says wiki_not_configured, and every owner asks before a wiki delete', async () => {
  const declarations = await configWith({ 'operator.yaml': 'model: a/b\n' });
  const state = join(await mkdtemp(join(tmpdir(), 'onionsoup-wiki-none-')), 'state');
  const hooks = await withActiveHooks({} as Parameters<Plugin>[0], { declarations, state });
  await assert.rejects(hooks.tool!.onionsoup_wiki!.execute({ action: 'list' } as never, toolContext('Bellonda') as never), /^Error: wiki_not_configured/);
  const config: { agent?: Record<string, { permission?: Record<string, unknown>; prompt?: string }> } = {};
  await hooks.config!(config as never);
  assert.equal(config.agent!['Miles Teg']!.permission![WIKI_DELETE_PERMISSION], 'ask');
  assert.equal(config.agent!.Operator!.permission!.onionsoup_wiki, 'allow', 'the operator may call it');
  assert.equal(config.agent!.Operator!.permission!['onionsoup_*'], 'deny', 'and no other onionsoup tool');
  assert.equal(config.agent!['onionsoup-implementer']!.permission!['onionsoup_*'], 'deny');
  assert.equal(config.agent!['onionsoup-implementer']!.permission!.onionsoup_wiki, undefined, 'subagents stay without it');
  assert.ok(!existsSync(join(state, '..', 'wiki')), 'no clone without a wiki');
});

test('owner prompts name the keeper, and the keeper is told she writes the wiki', async () => {
  const { hooks } = await wikiHooks();
  const config: { agent?: Record<string, { prompt?: string }> } = {};
  await hooks.config!(config as never);
  assert.match(config.agent!.Bellonda!.prompt!, /You keep the wiki/);
  assert.match(config.agent!['Miles Teg']!.prompt!, /Bellonda keeps the wiki[^]*onionsoup_ask/);
  assert.match(config.agent!['Miles Teg']!.prompt!, /onionsoup_wiki \(the homelab wiki/);
});
