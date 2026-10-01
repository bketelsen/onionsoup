import type { Plugin } from '@opencode-ai/plugin';
import { join } from 'node:path';
import type { Runtime } from './runtime.ts';
import type { MaintenancePass } from './plugin-maintenance.ts';
import { claimNotice, pendingNotices, restoreUnsentNotice, NOTICE_PREFIX, type WorkNotice } from './notices.ts';
import { nextMessageId } from './plan-revision.ts';
import { writeHandoffFile } from './operator-handoff-file.ts';
import { z } from 'zod';
import { ChatOrigin } from './chat-origin.ts';
import { MaintenanceEffectNotStarted } from './maintenance-context.ts';

export const WorkNoticeDelivery = z.object({ noticeID: z.string(), messageID: z.string(), origin: ChatOrigin,
  operationID: z.uuid(), status: z.enum(['prepared', 'sent', 'uncertain', 'not-sent']) });

async function deliverNotice(runtime: Runtime, client: Parameters<Plugin>[0]['client'],
  pass: MaintenancePass, notice: WorkNotice) {
  const owner = runtime.declarations.owners.get(notice.owner);
  if (!owner?.persona || !notice.origin) return;
  pass.check();
  const { sessionID, directory } = notice.origin;
  const status = await client.session.status({ query: { directory } });
  if (status.error || !status.data) return;
  if (status.data[sessionID] && status.data[sessionID].type !== 'idle') return;
  pass.check();
  if (!await claimNotice(runtime, notice.id)) return;
  const receipt = WorkNoticeDelivery.parse({ noticeID: notice.id, messageID: nextMessageId([]), origin: notice.origin,
    operationID: pass.record.operationID, status: 'prepared' });
  const path = join(runtime.stateDirectory, 'notices', 'delivery', `${receipt.messageID}.json`);
  await writeHandoffFile(path, JSON.stringify(receipt));
  let attempted = false;
  try {
    pass.check();
    attempted = true;
    await client.session.promptAsync({ path: { id: sessionID }, query: { directory },
      body: { agent: owner.persona.name, messageID: receipt.messageID,
        parts: [{ type: 'text', text: `${NOTICE_PREFIX} ${notice.text}` }] } });
    receipt.status = 'sent';
  } catch (error) {
    receipt.status = !attempted || error instanceof MaintenanceEffectNotStarted ? 'not-sent' : 'uncertain';
    await writeHandoffFile(path, JSON.stringify(receipt));
    if (receipt.status === 'not-sent') await restoreUnsentNotice(runtime, notice);
    // The retained notice claim and exact message identity prevent an ambiguous send from becoming a replay.
    throw error;
  }
  await writeHandoffFile(path, JSON.stringify(receipt));
}

export async function deliverWorkNotices(runtime: Runtime, client: Parameters<Plugin>[0]['client'], pass: MaintenancePass) {
  for (const notice of await pendingNotices(runtime)) {
    pass.check();
    await deliverNotice(runtime, client, pass, notice);
  }
}
