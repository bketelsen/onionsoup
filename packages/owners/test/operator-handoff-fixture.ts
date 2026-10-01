import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OPERATOR_CHECK_TOOL } from '../src/operator-write-call.ts';
import { fixture, start } from './operator-write-host-fixture.ts';

export async function setupHandoffFixture(options: { combinedFails?: boolean; checks?: boolean } = {}) {
  const context = await fixture();
  await writeFile(join(context.directory, 'a.mjs'), 'export default 0;\n');
  await writeFile(join(context.directory, 'b.mjs'), 'export default 0;\n');
  const assertion = options.combinedFails ? 'assert.notEqual(a+b,3)' : 'assert.ok(a+b<=3)';
  await writeFile(join(context.directory, 'combined.test.mjs'),
    `import {test} from 'node:test'; import assert from 'node:assert/strict'; import a from './a.mjs'; import b from './b.mjs'; test('combined contract',()=>${assertion});\n`);
  await context.git(['add', '.']);
  await context.git(['commit', '-qm', 'combined fixture baseline']);
  const head = (await context.git(['rev-parse', 'HEAD'])).stdout.trim();
  const second = join(context.workspace, 'second');
  await context.git(['worktree', 'add', '-q', '--detach', second, head]);
  const checks = options.checks === false ? undefined : [{ id: 'unit', command: ['node', '--test', 'combined.test.mjs'] }];
  context.input.key = 'combined-preview';
  context.input.goal = 'Combine two independently accepted edits without applying them';
  context.intake.text = 'Edit the two modules in separate worktrees, check each, and prepare a combined preview.';
  context.input.tasks = [
    { id: 'left', goal: 'Update a', directory: context.directory, access: 'write', files: ['a.mjs'], checks, dependsOn: [] },
    { id: 'right', goal: 'Update b', directory: second, access: 'write', files: ['b.mjs'], checks, dependsOn: [] },
  ];
  return { ...context, second, head };
}

export type HandoffFixture = Awaited<ReturnType<typeof setupHandoffFixture>>;

export async function acceptHandoffChildren(context: HandoffFixture,
  updates: Record<string, Record<string, string>> = { left: { 'a.mjs': 'export default 1;\n' }, right: { 'b.mjs': 'export default 2;\n' } }) {
  const started = await start(context);
  let sequence = 0;
  for (const original of started.children) {
    for (const [path, content] of Object.entries(updates[original.id]!)) {
      const messageID = `msg_handoff_write_${sequence++}`;
      const callID = `call_handoff_write_${sequence}`;
      context.client.tool(original.sessionID!, messageID, callID);
      const child = (await context.jobs.get(context.origin, started.id)).children.find(child => child.id === original.id)!;
      const source = child.write!.baseline.files.find(file => file.path === path);
      const toolContext = { ...context.childContext(child.sessionID!, messageID), directory: child.directory };
      await context.writes.file(toolContext, callID, { path, content, expectedBeforeSha256: source?.sha256 ?? 'absent' });
    }
    for (const check of original.checks ?? []) {
      const messageID = `msg_handoff_check_${sequence++}`;
      const callID = `call_handoff_check_${sequence}`;
      context.client.tool(original.sessionID!, messageID, callID, OPERATOR_CHECK_TOOL);
      const toolContext = { ...context.childContext(original.sessionID!, messageID), directory: original.directory };
      const receipt = await context.writes.check(toolContext, callID, { checkID: check.id });
      assert.equal(receipt.exitCode, 0, 'each child independently passes its approved check');
    }
    context.client.finish(original.sessionID!);
  }
  await context.supervisor.tick();
  for (const child of started.children) {
    if (child.access !== 'write') continue;
    const preview = await context.writes.review(context.origin, started.id, child.id);
    await context.writes.accept(context.origin, started.id, child.id, preview.digest, context.parent());
  }
  return { ...context, id: started.id, jobID: started.id };
}

export async function handoffFixture(options: Parameters<typeof setupHandoffFixture>[0] = {}) {
  return acceptHandoffChildren(await setupHandoffFixture(options));
}
