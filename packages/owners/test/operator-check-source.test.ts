import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { copyOperatorCheckSourceFiles, validateOperatorCheckSourceFiles, type OperatorCheckSourceFile } from '../src/operator-check-source.ts';
import { operatorHandoffSourceDigest } from '../src/operator-handoff-artifact.ts';
import { operatorWriteSha256, readOperatorWriteSourceFiles, snapshotOperatorWriteWorkspace } from '../src/operator-write-workspace.ts';

const file = (path: string, content = 'instructions', mode = 0o100644): OperatorCheckSourceFile => ({ path, content: Buffer.from(content), mode });
const link = (path: string, target: string) => file(path, target, 0o120000);
const aliases = () => [file('AGENTS.md'), file('.agents/skills/review/SKILL.md'), link('CLAUDE.md', 'AGENTS.md'),
  link('GEMINI.md', 'AGENTS.md'), link('.claude/skills', '../.agents/skills'), link('.gemini/skills', '../.agents/skills')];

test('tracked instruction file and directory aliases copy as exact internal symlinks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'operator-source-aliases-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = aliases();
  source.push(link('INSTRUCTIONS.md', 'CLAUDE.md'), link('skill.md', '.claude/skills/review/SKILL.md'));
  assert.equal(validateOperatorCheckSourceFiles(source).size, source.length);
  await copyOperatorCheckSourceFiles(directory, source);
  assert.equal(await readlink(join(directory, '.claude/skills')), '../.agents/skills');
  assert.equal(await readlink(join(directory, 'CLAUDE.md')), 'AGENTS.md');
  assert.equal(await readFile(join(directory, 'skill.md'), 'utf8'), 'instructions');
  assert.equal(await readFile(join(directory, 'INSTRUCTIONS.md'), 'utf8'), 'instructions');
  await assert.rejects(copyOperatorCheckSourceFiles(directory, source), /source_invalid/);
});

const invalidTrees: Record<string, OperatorCheckSourceFile[]> = {
  absolute: [link('alias', '/etc/passwd')],
  escaping: [link('alias', '../secret')],
  nestedEscape: [link('dir/alias', '../../secret')],
  metadata: [link('alias', '.git/config')],
  chainedEscape: [link('first', 'second'), link('second', '../secret')],
  self: [link('alias', 'alias')],
  cycle: [link('first', 'second'), link('second', 'first')],
  rootCycle: [link('alias', '.')],
  directoryCycle: [file('a/file'), file('b/file'), link('a/alias', '../b'), link('b/alias', '../a')],
  collision: [file('real/file'), link('alias', 'real'), file('alias/file')],
  regularAncestor: [file('file'), file('file/child')],
  dangling: [link('alias', 'absent')],
  null: [link('alias', 'AGENTS.md\0'), file('AGENTS.md')],
  symlinkPermissions: [file('alias', 'AGENTS.md', 0o120777), file('AGENTS.md')],
  invalidEncoding: [{ path: 'alias', content: Buffer.from([255]), mode: 0o120000 }],
};
for (const [name, source] of Object.entries(invalidTrees)) {
  test(`source validation rejects ${name} before copying any entry`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'operator-source-reject-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    assert.throws(() => validateOperatorCheckSourceFiles(source), /source_invalid/);
    await assert.rejects(copyOperatorCheckSourceFiles(directory, source), /source_invalid/);
    assert.deepEqual(await readdir(directory), []);
  });
}

test('regular-file source digests retain the historical digest shape', () => {
  const source = [file('b', 'second', 0o100755), file('a', 'first')];
  const historical = operatorWriteSha256(JSON.stringify(source.map(entry => ({ path: entry.path,
    sha256: operatorWriteSha256(entry.content), mode: entry.mode })).sort((left, right) => left.path.localeCompare(right.path))));
  assert.equal(operatorHandoffSourceDigest(source), historical);
});

test('real Git instruction aliases survive snapshot source reading while write scope remains regular-file only', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'operator-git-aliases-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const directory = join(workspace, 'repo');
  await mkdir(directory);
  await copyOperatorCheckSourceFiles(directory, aliases());
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', directory, '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', ...args], { env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'instruction aliases');
  const input = { workspace, directory, files: ['AGENTS.md'], createFiles: ['Makefile'] };
  const snapshot = await snapshotOperatorWriteWorkspace(input);
  const source = await readOperatorWriteSourceFiles(snapshot, []);
  for (const expected of aliases()) {
    const actual = source.find(entry => entry.path === expected.path)!;
    assert.equal(actual.mode, expected.mode);
    assert.deepEqual(actual.content, expected.content);
  }
  assert.equal(source.length, aliases().length);
  await assert.rejects(snapshotOperatorWriteWorkspace({ ...input, files: ['CLAUDE.md'] }), /scope_file_invalid/);
  await assert.rejects(snapshotOperatorWriteWorkspace({ ...input, createFiles: ['.claude/skills/new.md'] }));
  const digest = operatorHandoffSourceDigest(source);
  await unlink(join(directory, 'CLAUDE.md'));
  await symlink('GEMINI.md', join(directory, 'CLAUDE.md'));
  await assert.rejects(readOperatorWriteSourceFiles(snapshot, []), /source_changed/);
  git('add', '.');
  git('commit', '-qm', 'changed alias');
  const changed = await readOperatorWriteSourceFiles(await snapshotOperatorWriteWorkspace(input), []);
  assert.notEqual(operatorHandoffSourceDigest(changed), digest, 'link text itself binds source evidence');
});
