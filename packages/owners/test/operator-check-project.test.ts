import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { preflightOperatorProjectCheck, prepareOperatorProjectCheck } from '../src/operator-check-project.ts';
import { runOperatorCheck, type PinnedOperatorCheckMount } from '../src/operator-check-runner.ts';

const tools = { make: '/usr/bin/make', sh: '/usr/bin/sh', git: '/usr/bin/git', env: '/usr/bin/env' };
function file(path: string, content: string) { return { path, content: Buffer.from(content), mode: 0o100600 }; }
async function withProfile(action: (directory: string, profile: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'operator-project-test-'));
  const profile = join(directory, 'tools.json');
  const previous = process.env.ONIONSOUP_PROJECT_TOOLS_FILE;
  await writeFile(profile, JSON.stringify({ tools }), { mode: 0o600 });
  process.env.ONIONSOUP_PROJECT_TOOLS_FILE = profile;
  try { await action(directory, profile); }
  finally {
    if (previous === undefined) delete process.env.ONIONSOUP_PROJECT_TOOLS_FILE;
    else process.env.ONIONSOUP_PROJECT_TOOLS_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('project checks run real Make and arbitrary repository scripts with a writable disposable copy and pinned evidence', async () => {
  await withProfile(async () => {
    await preflightOperatorProjectCheck();
    const sources = [file('Makefile', 'help:\n\t@printf "help works\\n"\ncheck:\n\t@./check.sh\n'),
      { ...file('check.sh', '#!/usr/bin/env sh\nset -eu\nprintf generated > generated.txt\nnode verify.mjs\n'), mode: 0o100700 },
      file('verify.mjs', `import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
assert.equal(readFileSync('generated.txt', 'utf8'), 'generated');
assert.equal(existsSync('/workspace/generated.txt'), false);
console.log('repository command checked');
`)];
    const help = await runOperatorCheck(['project', 'make', 'help'], sources);
    assert.equal(help.exitCode, 0, help.output);
    assert.match(help.output, /help works/);
    const checked = await runOperatorCheck(['project', 'make', 'check'], sources);
    assert.equal(checked.exitCode, 0, checked.output);
    assert.match(checked.output, /repository command checked/);
    assert.equal(checked.runtime?.kind, 'project');
    if (checked.runtime?.kind !== 'project') return;
    assert.match(checked.runtime.profileSha256, /^[a-f0-9]{64}$/);
    assert.ok(checked.runtime.tools.some(tool => tool.name === '/runtime/bin/make'));
    assert.ok(checked.runtime.tools.some(tool => tool.name === '/runtime/operator-project-launcher.mjs'));
    assert.ok(checked.runtime.tools.some(tool => /\/lib/.test(tool.name)));
    assert.deepEqual(checked.runtime, help.runtime);
  });
});

test('project commands cannot read host paths or credentials, reach host network, or mutate pinned sources and runtimes', async () => {
  await withProfile(async directory => {
    const marker = join(directory, 'host-marker');
    await writeFile(marker, 'synthetic host-only fixture');
    const server = createServer(socket => socket.end('unreachable'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    process.env.OPERATOR_PROJECT_SYNTHETIC_SECRET = 'must not inherit';
    try {
      const checked = await runOperatorCheck(['project', 'node', 'boundary.mjs'], [file('boundary.mjs', `
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
for (const path of [${JSON.stringify(marker)}, '/home', '/var/home', '/etc', '/workspace/.git']) {
 assert.equal(existsSync(path), false, path);
}
for (const path of ['/workspace/boundary.mjs', '/runtime/node', '/runtime/bin/make', '/root-file']) {
 assert.throws(() => writeFileSync(path, 'changed'), undefined, path);
}
assert.equal(process.env.OPERATOR_PROJECT_SYNTHETIC_SECRET, undefined);
await new Promise((resolve, reject) => {
 const socket = connect({host: '127.0.0.1', port: ${address.port}});
 socket.setTimeout(1000, () => {socket.destroy(); resolve();});
 socket.once('error', () => {socket.destroy(); resolve();});
 socket.once('connect', () => {socket.destroy(); reject(new Error('host network reachable'));});
});
console.log('boundary passed');
`)]);
      assert.equal(checked.exitCode, 0, checked.output);
      assert.match(checked.output, /boundary passed/);
      assert.equal(await readFile(marker, 'utf8'), 'synthetic host-only fixture');
    } finally {
      delete process.env.OPERATOR_PROJECT_SYNTHETIC_SECRET;
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

test('project Git fixtures are local ephemeral repositories without inherited identity or configuration', async () => {
  await withProfile(async () => {
    const checked = await runOperatorCheck(['project', 'sh', 'git-fixture.sh'], [file('git-fixture.sh', `set -eu
git init -q
git -c user.name=Fixture -c user.email=fixture@example.invalid add .
git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm 'feat: fixture'
git tag v1.2.3
git describe --tags --exact-match
`)]);
    assert.equal(checked.exitCode, 0, checked.output);
    assert.match(checked.output, /v1\.2\.3/);
  });
});

test('project host tool profiles fail closed on missing selection, unsafe names, writable files and non-ELF wrappers', async () => {
  await withProfile(async (directory, profile) => {
    delete process.env.ONIONSOUP_PROJECT_TOOLS_FILE;
    await assert.rejects(preflightOperatorProjectCheck(), /operator_check_project_runtime_unavailable/);
    process.env.ONIONSOUP_PROJECT_TOOLS_FILE = profile;
    await writeFile(profile, JSON.stringify({ tools: { '../escape': '/usr/bin/sh' } }));
    await assert.rejects(preflightOperatorProjectCheck(), /operator_check_project_profile_invalid/);
    const wrapper = join(directory, 'wrapper');
    await writeFile(wrapper, '#!/bin/sh\ntouch SHOULD_NOT_EXIST\n', { mode: 0o700 });
    await writeFile(profile, JSON.stringify({ tools: { wrapper } }));
    await assert.rejects(preflightOperatorProjectCheck(), /operator_check_project_executable_not_elf/);
    await chmod(profile, 0o666);
    await assert.rejects(preflightOperatorProjectCheck(), /operator_check_project_runtime_invalid/);
  });
});


test('prepared project runtimes execute immutable bytes despite later replacement of a selected tool', async () => {
  await withProfile(async (directory, profile) => {
    const selected = join(directory, 'selected-make');
    await copyFile('/usr/bin/make', selected);
    await chmod(selected, 0o700);
    await writeFile(profile, JSON.stringify({ tools: { make: selected } }));
    const scratch = join(directory, 'runtime');
    await mkdir(scratch);
    const mounts: PinnedOperatorCheckMount[] = [];
    try {
      const runtime = await prepareOperatorProjectCheck(scratch, mounts);
      assert.equal(runtime.evidence?.kind, 'project');
      if (runtime.evidence?.kind !== 'project') return;
      const originalHash = createHash('sha256').update(await readFile(selected)).digest('hex');
      await writeFile(selected, 'replacement must never run');
      const pinned = mounts.find(mount => mount.destination === '/runtime/bin/make');
      assert.ok(pinned);
      const pinnedHash = createHash('sha256').update(await readFile(`/proc/self/fd/${pinned.handle.fd}`)).digest('hex');
      assert.equal(pinnedHash, originalHash);
      assert.equal(runtime.evidence.tools.find(tool => tool.name === '/runtime/bin/make')?.binarySha256, pinnedHash);
    } finally { for (const mount of mounts.reverse()) await mount.handle.close(); }
  });
});
