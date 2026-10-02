import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { humanWorkActor, pauseItem, settleItemPause } from '../src/work-pause.ts';
import { workPauseClient } from '../src/work-pause-client.ts';
import { resumeItem } from '../src/work-recovery.ts';
import { pendingNotices, queueNotice } from '../src/notices.ts';
import { messageFixture } from './owner-message-fixture.ts';

test('queued actionable notices and exact not-sent receipts stay fenced while execution is deliberately paused', async () => {
  const context = await messageFixture();
  const execution = await context.addSession('homelab', 'ses_execution');
  const proposal = { title: 'Original work', goal: 'Preserve original intent', rationale: 'Regression', acceptance: ['Pause fences dispatch'], size: 'small' as const };
  const item = await context.runtime.ledger.create('homelab', 'owner-change', proposal, { status: 'working', session: execution });
  await queueNotice(context.runtime, {
    id: 'pending-action', owner: 'homelab', workItem: item.id, origin: execution,
    change: 'manager-ruling', text: 'Continue the original work.', at: new Date().toISOString(),
  });
  const pass = context.pass();
  const check = pass.check.bind(pass);
  pass.check = () => {
    if (existsSync(join(context.runtime.stateDirectory, 'notices', 'delivery'))) pass.stop();
    check();
  };
  await assert.rejects(context.deliver(context.runtime, pass), /plugin_maintenance_stopped/);
  const receipt = (await context.receipts())[0]!;
  assert.equal(receipt.status, 'not-sent');
  const attemptedBeforePause = context.sends.length;
  await pauseItem(context.runtime, item.id, humanWorkActor(), 'Stop intentionally');
  await settleItemPause(context.runtime, item.id, workPauseClient({
    sessions: async directory => [...context.sessions.values()].filter(session => session.directory === directory),
    statuses: async () => ({}),
    abort: async () => { throw new Error('already_idle_execution_must_not_abort'); },
  }));
  assert.equal((await context.runtime.ledger.get(item.id)).status, 'paused');
  await assert.rejects(context.deliver(), /work_item_paused/);
  assert.equal(context.sends.length, attemptedBeforePause);
  assert.equal((await pendingNotices(context.runtime))[0]?.id, 'pending-action');
  const retained = (await context.receipts())[0]!;
  assert.equal(retained.messageID, receipt.messageID);
  assert.equal(retained.text, receipt.text);
  await resumeItem(context.runtime, item.id, humanWorkActor());
  await context.deliver();
  const delivered = (await context.receipts()).find(saved => saved.noticeID === 'pending-action')!;
  assert.equal(delivered.status, 'sent');
  assert.equal(delivered.messageID, receipt.messageID);
  assert.equal(delivered.text, receipt.text);
});
