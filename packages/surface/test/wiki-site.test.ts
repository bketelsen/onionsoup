import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { SurfaceState, surfaceServer, type OpencodeApi } from '@onionsoup/surface';
import { wikiRuntime } from '../../owners/test/wiki-fixture.ts';

const PAGES: Record<string, string> = {
  'docs/index.md': '---\norder: 1\n---\n# Homelab\n\nSee the [network](network.md), [selfie\'s GPU](hosts/selfie.md#gpu-drivers) and the [hosts](hosts/index.md).\n',
  'docs/network.md': '---\norder: 20\n---\n# Network\n\n## VLANs\n\n## VLANs\n\n| VLAN | Use |\n| --- | --- |\n| 1 | default |\n',
  'docs/storage.md': '---\norder: 10\n---\n# Storage\n\nPools live on [selfie](hosts/selfie.md).\n',
  'docs/hosts/index.md': '---\norder: 30\n---\n# Hosts\n',
  'docs/hosts/selfie.md': '---\norder: 31\n---\n# Selfie\n\nBackups go to [storage](../storage.md).\n\n## GPU & drivers\n\nOne card.\n',
  'docs/links.md': '# Links\n\nVisit the [network](/network.md#vlans) or [hosts](/hosts/) and [external](https://example.org/). [unsafe](/../api/state) [encoded](/wiki/%2e%2e/api/state) [backslash](/wiki/\\../api/state) [relative escape](../api/state) [asset](images/map.png).\n',
  'docs/unsafe.md': [
    '# Unsafe',
    '',
    '<script>alert("page")</script>',
    '',
    'Inline <img src=x onerror="alert(1)"> and [a trap](javascript:alert(2)) and <javascript:alert(3)>.',
    '',
  ].join('\n'),
};

async function startSite(context: TestContext) {
  const fixture = await wikiRuntime(PAGES);
  const state = new SurfaceState(fixture.runtime, { health: async () => ({ ok: true }) } as OpencodeApi);
  const { server } = surfaceServer(state, { webRoot: '/nonexistent', buildId: null, wiki: fixture.wiki });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${base}${path}`, init);
    return { status: response.status, headers: response.headers, html: await response.text() };
  };
  const rawStatus = (path: string) => new Promise<number>((resolve, reject) => {
    const request = httpRequest(base, { path }, response => {
      response.resume();
      resolve(response.statusCode!);
    });
    request.on('error', reject);
    request.end();
  });
  return { ...fixture, get, rawStatus };
}

function sidebar(html: string) {
  return /<nav class="pages"[^>]*>([^]*?)<\/nav>/.exec(html)?.[1] ?? '';
}

function linkTexts(html: string) {
  return [...html.matchAll(/<a [^>]*>([^<]*)<\/a>|<span class="section">([^<]*)<\/span>/g)].map(match => match[1] ?? `${match[2]}/`);
}

test('the index renders with the sidebar in order, index first, and a search box', async context => {
  const { get } = await startSite(context);
  const { status, html, headers } = await get('/wiki/');
  assert.equal(status, 200);
  assert.equal(headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(html, /<title>Homelab<\/title>/);
  assert.deepEqual(linkTexts(sidebar(html)), ['Homelab', 'Storage', 'Network', 'Hosts/', 'Hosts', 'Selfie', 'Links', 'Unsafe']);
  assert.match(sidebar(html), /<a href="\/wiki\/" aria-current="page">Homelab<\/a>/);
  assert.match(html, /<form action="\/wiki\/search" method="get" role="search"><input type="search" name="q"/);
});

test('a page fits a phone: it reaches under the safe areas it pads for, and the pages list follows the content with a jump to it', async context => {
  const { get } = await startSite(context);
  const { html } = await get('/wiki/network');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
  assert.match(html, /<a class="jump" href="#pages">Pages<\/a>/);
  assert.match(html, /<main>[^]*<\/main>\s*<nav class="pages" id="pages"/, 'without script, the sidebar moves below the page on a phone');
  assert.doesNotMatch(html, /<script/i);
});

test('a page renders with heading ids, permalinks and working relative links', async context => {
  const { get } = await startSite(context);
  const index = await get('/wiki/');
  assert.match(index.html, /<a href="\/wiki\/network">network<\/a>/);
  assert.match(index.html, /<a href="\/wiki\/hosts\/selfie#gpu-drivers">selfie&#39;s GPU<\/a>/, 'a link with an anchor keeps it');
  assert.match(index.html, /<a href="\/wiki\/hosts\/">hosts<\/a>/);
  const selfie = await get('/wiki/hosts/selfie');
  assert.equal(selfie.status, 200);
  assert.match(selfie.html, /<h2 id="gpu-drivers">GPU &amp; drivers<a class="permalink" href="#gpu-drivers" aria-label="Link to this section">¶<\/a><\/h2>/);
  assert.match(selfie.html, /<a href="\/wiki\/storage">storage<\/a>/, '../ links resolve');
  assert.match(selfie.html, /<section class="backlinks"><h2>Linked from<\/h2><ul><li><a href="\/wiki\/">Homelab<\/a><\/li><li><a href="\/wiki\/storage">Storage<\/a><\/li><\/ul>/);
  assert.match(selfie.html, /Updated by Seed, <time datetime="[^"]+"[^>]*>[^<]+<\/time>\. <a href="\/wiki\/history\/hosts\/selfie">History<\/a>/);
  const network = await get('/wiki/network');
  assert.match(network.html, /<h2 id="vlans">[^]*<h2 id="vlans_1">/, 'a repeated heading gets a unique id');
  assert.match(network.html, /<table>/);
  assert.equal((await get('/wiki/hosts/')).status, 200);
  assert.equal((await get('/wiki/network.md')).status, 200, 'a page is also found by its file name');
  const missing = await get('/wiki/nowhere');
  assert.equal(missing.status, 404);
  assert.match(missing.html, /Not found/);
});

test('raw HTML in a page is shown as text, never emitted, and unsafe links are dropped', async context => {
  const { get } = await startSite(context);
  const { html, headers } = await get('/wiki/unsafe');
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img[^>]*onerror/i);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, /&lt;script&gt;alert\(&quot;page&quot;\)&lt;\/script&gt;/);
  assert.match(html, /a trap/);
  const policy = headers.get('content-security-policy') ?? '';
  assert.match(policy, /default-src 'none'/);
  assert.doesNotMatch(policy, /script-src/, 'no script may run');
  assert.match(policy, /style-src 'sha256-[A-Za-z0-9+/=]+'/);
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
});

test('wiki-local absolute markdown links stay under the wiki mount', async context => {
  const { get } = await startSite(context);
  const { html } = await get('/wiki/links');
  assert.match(html, /href="\/wiki\/network#vlans"/);
  assert.match(html, /href="\/wiki\/hosts\/"/);
  assert.match(html, /href="https:\/\/example.org\/"/);
  assert.doesNotMatch(html, /href="\/wiki\/(?:\.\.|%2e)/i);
  assert.doesNotMatch(html, /href="\/api\/state"/);
  assert.doesNotMatch(html, /href="[^"]*\\/);
  assert.match(html, /href="\/wiki\/images\/map.png"/);
  assert.doesNotMatch(html, /href="\.\.\/api\/state"/);
});

test('search finds pages with snippets, and history shows the commits', async context => {
  const { get, wiki } = await startSite(context);
  const search = await get('/wiki/search?q=backups');
  assert.equal(search.status, 200);
  assert.match(search.html, /<h1>Search: backups<\/h1><ol class="results"><li><a href="\/wiki\/hosts\/selfie">Selfie<\/a><br><span class="muted">[^<]*Backups go to/);
  assert.match((await get('/wiki/search?q=zebra')).html, /No pages match/);
  assert.match((await get('/wiki/search?q=%3Cscript%3E')).html, /Search: &lt;script&gt;/);
  await wiki.write('bellonda', 'network.md', '---\norder: 20\n---\n# Network\n\nOne VLAN.\n', 'Simplify the network page');
  const history = await get('/wiki/history/network');
  assert.equal(history.status, 200);
  assert.match(history.html, /<td>Bellonda<\/td><td>Simplify the network page<\/td>[^]*<td>Seed<\/td><td>Seed the wiki<\/td>/);
  assert.match((await get('/wiki/network')).html, /Updated by Bellonda/);
  assert.equal((await get('/wiki/history/nowhere')).status, 404);
});

test('the shared listener isolates wiki paths, preserves API routing, and rejects wiki writes', async context => {
  const { get, rawStatus } = await startSite(context);
  assert.equal((await get('/api/unknown')).status, 404);
  assert.equal((await get('/wiki/api/state')).status, 404);
  assert.equal((await get('/wikiish')).status, 404);
  assert.equal(await rawStatus('/wiki/%2e%2e/api/state'), 404);
  assert.equal(await rawStatus('/wiki/../api/state'), 404);
  assert.equal(await rawStatus('/wiki/.%2e/api/state'), 404);
  assert.equal(await rawStatus('/wiki\\../api/state'), 404);
  const post = await get('/wiki/network', { method: 'POST', body: '{}' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  const noSlash = await get('/wiki', { redirect: 'manual' });
  assert.equal(noSlash.status, 308);
  assert.equal(noSlash.headers.get('location'), '/wiki/');
});
