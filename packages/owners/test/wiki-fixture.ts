import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Runtime } from '../src/runtime.ts';
import { openWiki } from '../src/wiki.ts';

const run = promisify(execFile);
const fixture = 'packages/owners/test/fixtures/owners';
const SEED_IDENTITY = ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.invalid', '-c', 'commit.gpgsign=false'];

export async function gitIn(directory: string, ...args: string[]) {
  return (await run('git', ['-C', directory, ...SEED_IDENTITY, ...args])).stdout.trim();
}

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

/** A bare repository standing in for the wiki's GitHub remote, holding one commit of these files. */
export async function wikiRemote(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'onionsoup-wiki-remote-'));
  const remote = join(root, 'wiki.git');
  await run('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const seed = join(root, 'seed');
  await run('git', ['clone', '-q', remote, seed]);
  await gitIn(seed, 'checkout', '-q', '-b', 'main');
  await writeFiles(seed, files);
  await gitIn(seed, 'add', '-A');
  await gitIn(seed, 'commit', '-q', '-m', 'Seed the wiki');
  await gitIn(seed, 'push', '-q', 'origin', 'main');
  return remote;
}

/** Someone else pushes to the remote: a clone of it, these files changed, committed and pushed. */
export async function pushElsewhere(remote: string, files: Record<string, string>, subject = 'Edited elsewhere') {
  const clone = await mkdtemp(join(tmpdir(), 'onionsoup-wiki-elsewhere-'));
  await run('git', ['clone', '-q', remote, clone]);
  await writeFiles(clone, files);
  await gitIn(clone, 'add', '-A');
  await gitIn(clone, 'commit', '-q', '-m', subject);
  await gitIn(clone, 'push', '-q', 'origin', 'HEAD:main');
}

/** The remote's latest commit as `author <email>|subject`. */
export async function remoteHead(remote: string) {
  return gitIn(remote, 'log', '-1', '--format=%an <%ae>|%s', 'main');
}

export async function remoteFile(remote: string, path: string) {
  return gitIn(remote, 'show', `main:${path}`);
}

/** The test owners' configuration, copied, with extra files (wiki.yaml, operator.yaml). */
export async function configWith(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'onionsoup-wiki-config-'));
  await cp(fixture, root, { recursive: true });
  await writeFiles(root, files);
  return root;
}

export function wikiYaml(remote: string, keeper = 'bellonda') {
  return `repository: ${remote}\nlisten: 127.0.0.1:4748\nkeeper: ${keeper}\n`;
}

/** A runtime whose configuration declares a wiki on a fresh remote of these files, kept by Bellonda. */
export async function wikiRuntime(files: Record<string, string>, extra: Record<string, string> = {}) {
  const remote = await wikiRemote(files);
  const declarations = await configWith({ 'wiki.yaml': wikiYaml(remote), ...extra });
  // The clone lives beside the state directory, at <home>/wiki: each test gets its own home.
  const state = join(await mkdtemp(join(tmpdir(), 'onionsoup-wiki-home-')), 'state');
  const runtime = await Runtime.open({ declarations, state });
  return { runtime, wiki: openWiki(runtime), remote, declarations, state };
}

/** A small wiki shaped like homewiki: an index, topic pages and a hosts section, cross-linked. */
export const HOMEWIKI: Record<string, string> = {
  'mkdocs.yml': `site_name: Homelab
nav:
  - Homelab: index.md
  - Network: network.md
  - Storage: storage.md
  - Hosts:
      - selfie: hosts/selfie.md
      - minideb: hosts/minideb.md
  - Services: services.md
  - GitHub: https://github.com/bketelsen/homewiki
markdown_extensions:
  - toc:
      permalink: true
`,
  'docs/index.md': '# Homelab\n\nStart with the [network](network.md) and [selfie](hosts/selfie.md#gpu).\n',
  'docs/network.md': '# Network\n\nThe UDM Pro routes 10.0.1.0/24. VLANs are listed below.\n\n## VLANs\n\n| VLAN | Use |\n| --- | --- |\n| 1 | default |\n',
  'docs/storage.md': '# Storage\n\nTrueNAS holds the pools. See [selfie](hosts/selfie.md).\n',
  'docs/services.md': '---\nsources: [truenas]\n---\n# Services\n\nCaddy fronts everything.\n',
  'docs/hosts/selfie.md': '# Selfie\n\nThe GPU box. Backups go to [storage](../storage.md).\n\n## GPU\n\nOne card.\n',
  'docs/hosts/minideb.md': 'Minideb runs Coder.\n',
};
