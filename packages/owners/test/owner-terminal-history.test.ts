import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sendOwnerMessage } from '../src/owner-messages.ts';
import { rememberedSession } from '../src/session-history.ts';
import { messageFixture } from './owner-message-fixture.ts';

test('a terminal execution address with no retained worktree routes through history without probing the existing old directory', async () => {
  const context = await messageFixture();
  const sender = await context.addSession('odrade', 'ses_sender');
  const terminal = await context.addSession('homelab', 'ses_terminal', join(context.root, 'old-execution'));
  const proposal = { title: 'Finished work', goal: 'Read retained intent', rationale: 'Regression', acceptance: ['No old probes'], size: 'small' as const };
  const item = await context.runtime.ledger.create('homelab', 'owner-change', proposal, { status: 'cancelled', session: terminal });
  await sendOwnerMessage(context.runtime, 'odrade', { to: 'homelab', item: item.id, text: 'Explain the recorded outcome.' }, sender, 'msg_terminal');
  await context.deliver();
  assert.equal(existsSync(terminal.directory), true);
  assert.equal(context.queries.some(query => query.directory === terminal.directory), false);
  assert.equal(context.creates(), 1);
  assert.notEqual(context.sends[0]?.path.id, terminal.sessionID);
  assert.match(context.sends[0]!.body.parts[0].text, /homelab's original context/);
  assert.equal((await rememberedSession(context.runtime, terminal.sessionID))?.directory, terminal.directory);
  assert.equal((await rememberedSession(context.runtime, terminal.sessionID))?.archived, true);
});
