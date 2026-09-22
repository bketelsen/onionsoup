import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { openJobHost, type JobHost } from '@onionsoup/job-host';
import { RepositoryRegistry, detectProfile, registeredCapabilities } from '../src/index.ts';

const execute = promisify(execFile);
const git = (cwd: string, args: string[]) => execute('git', args, { cwd });

async function fakeGitHubRepository(root: string, name: string, files: Record<string, string>) {
  const directory = join(root, 'origin', name.replace('/', '--'));
  await mkdir(directory, { recursive: true });
  for (const [path, text] of Object.entries(files)) { await mkdir(join(directory, path, '..'), { recursive: true }); await writeFile(join(directory, path), text); }
  await git(directory, ['init', '-q', '-b', 'main']);
  await git(directory, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '.']);
  await git(directory, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init']);
  return directory;
}

async function settled(host: JobHost, id: string) {
  for (let n = 0; n < 600; n++) {
    const job = await host.inspect('web', id);
    if (!['queued', 'running'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timeout');
}

test('onboarding clones, detects a build or test profile, lists, updates, and refuses configured repositories', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'onboarding-'));
  const nodeHash = createHash('sha256').update(await readFile(process.execPath)).digest('hex');
  const runtimeFile = join(root, 'runtime.json');
  await writeFile(runtimeFile, JSON.stringify({ schemaVersion: 1, imageId: 'sha256:' + 'a'.repeat(64), nodePath: process.execPath, nodeHash, podmanVersion: 'fixture' }));
  const site = await fakeGitHubRepository(root, 'someone/site', { 'package.json': JSON.stringify({ name: 'site', scripts: { build: 'astro build' }, dependencies: { astro: '^7' } }), 'package-lock.json': '{}', 'src/pages/index.astro': '<h1>hi</h1>' });
  const library = await fakeGitHubRepository(root, 'someone/library', { 'package.json': JSON.stringify({ name: 'library', devDependencies: { typescript: '^5', tsx: '^4' } }), 'package-lock.json': '{}', 'test/library.test.ts': 'test("x",()=>{});' });
  const goModule = await fakeGitHubRepository(root, 'someone/tool', { 'go.mod': 'module github.com/someone/tool\n', 'main.go': 'package main\nfunc main(){}\n' });
  const origins: Record<string, string> = { 'someone/site': site, 'someone/library': library, 'someone/tool': goModule };
  const lookup = async (name: string) => ({ id: 7, default_branch: 'main', clone_url: origins[name], private: true });
  const clone = async (name: string, directory: string) => { await git(root, ['clone', '-q', origins[name], directory]); };

  const registry = await RepositoryRegistry.open({ directory: join(root, 'registry'), entries: [{ name: 'someone/fixed', checkout: '/unused' }], nodeRuntime: runtimeFile });
  const capabilities = registeredCapabilities({ schemaVersion: 2, models: { default: { provider: 'copilot', model: 'gpt-5.6-terra' } }, repositories: ['someone/fixed'] }, {
    registry, onboarding: { lookup, clone }, models: async () => { throw new Error('no model'); }, repositoryBrief: async () => { throw new Error('no'); },
  });
  const ids = capabilities.map((c) => c.id);
  assert.ok(['repository.list', 'repository.onboard', 'repository.update', 'repository.search'].every((id) => ids.includes(id)));
  const host = await openJobHost({ directory: join(root, 'host'), binding: {}, capabilities, invokers: [{ id: 'web', capabilities: ids }] });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });

  const run = async (capability: string, input: unknown, key: string) => settled(host, (await host.submit('web', { capability, input, idempotencyKey: key })).jobId);

  const before = host.discover('web').capabilities.find((c) => c.id === 'issue.readiness')!.inputSchema as any;
  assert.deepEqual(before.properties.repository.enum, ['someone/fixed']);

  const siteJob = await run('repository.onboard', { repository: 'someone/site' }, 'onboard-site');
  assert.equal(siteJob.status, 'completed', siteJob.error);
  const siteResult = siteJob.result as any;
  assert.equal(siteResult.cloned, true);
  assert.equal(siteResult.repository.implementation, true);
  assert.deepEqual(siteResult.repository.profile.verification, { required: ['node-build'], build: { bin: 'astro', args: ['build'] } });
  assert.deepEqual(siteJob.outcome, { status: 'ok', label: siteResult.note });

  const libraryJob = await run('repository.onboard', { repository: 'someone/library' }, 'onboard-library');
  assert.deepEqual((libraryJob.result as any).repository.profile.verification, { required: ['node-typecheck', 'node-tests'], testFiles: ['test/library.test.ts'] });

  const goJob = await run('repository.onboard', { repository: 'someone/tool' }, 'onboard-go');
  assert.equal((goJob.result as any).repository.implementation, false);
  assert.equal(goJob.outcome?.status, 'partial');

  // The catalog reflects the registry immediately: every repository input offers the new names.
  const after = host.discover('web').capabilities.find((c) => c.id === 'issue.readiness')!.inputSchema as any;
  assert.deepEqual(after.properties.repository.enum, ['someone/fixed', 'someone/site', 'someone/library', 'someone/tool']);
  const requestSchema = host.discover('web').capabilities.find((c) => c.id === 'change.request')!.inputSchema as any;
  assert.deepEqual(requestSchema.properties.repository.enum, ['someone/site', 'someone/library']);

  const again = await run('repository.onboard', { repository: 'someone/site' }, 'onboard-site-again');
  assert.equal((again.result as any).cloned, false);
  const fixed = await run('repository.onboard', { repository: 'someone/fixed' }, 'onboard-fixed');
  assert.equal(fixed.error, 'repository_fixed_by_config');

  const listed = await run('repository.list', {}, 'list-jobs-1');
  assert.deepEqual((listed.result as any).repositories.map((r: any) => [r.name, r.origin, r.implementation]), [['someone/fixed', 'config', false], ['someone/site', 'registry', true], ['someone/library', 'registry', true], ['someone/tool', 'registry', false]]);

  const updated = await run('repository.update', { repository: 'someone/site', allowedPaths: ['src/**'], maximumFiles: 5, existingTests: 'append-only' }, 'update-site-1');
  assert.equal(updated.status, 'completed', updated.error);
  assert.deepEqual((updated.result as any).repository.profile.changes.allowed, ['src/**']);
  const saved = JSON.parse(await readFile(join(registry.home('someone/site'), 'profile.json'), 'utf8'));
  assert.equal(saved.changes.maximumFiles, 5);
  const notEditable = await run('repository.update', { repository: 'someone/tool', maximumFiles: 3 }, 'update-go-tool');
  assert.equal(notEditable.error, 'repository_has_no_profile');

  // A second registry over the same directory sees the onboarded repositories.
  const reopened = await RepositoryRegistry.open({ directory: join(root, 'registry'), entries: [], nodeRuntime: runtimeFile });
  assert.deepEqual(reopened.names(), ['someone/site', 'someone/library', 'someone/tool']);
});

test('profile detection is honest about what it cannot verify', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'detect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shell = await fakeGitHubRepository(root, 'someone/shell', { 'package.json': JSON.stringify({ scripts: { build: 'sh ./build.sh && echo done' } }), 'package-lock.json': '{}' });
  const detected = await detectProfile(shell, 'someone/shell', 1, 'main', { schemaVersion: 1, imageId: 'sha256:' + 'a'.repeat(64), nodePath: process.execPath, nodeHash: 'b'.repeat(64), podmanVersion: 'x' });
  assert.equal(detected.profile, undefined);
  assert.match(detected.note, /not a plain package binary/);
  const none = await detectProfile(shell, 'someone/shell', 1, 'main', undefined);
  assert.match(none.note, /no Node sandbox runtime/);
});
