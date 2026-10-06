import type { Plugin } from '@opencode-ai/plugin';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Runtime } from './runtime.ts';
import type { MaintenancePass } from './plugin-maintenance.ts';
import { claimNotice, pendingNotices, readNotice, NOTICE_PREFIX, WorkNotice } from './notices.ts';
import { nextMessageId } from './plan-revision.ts';
import { writeDurableFile } from './durable-file.ts';
import { ChatOrigin } from './chat-origin.ts';
import { MaintenanceEffectNotStarted } from './maintenance-context.ts';
import { transcriptClient, type TranscriptMessage } from './transcript-client.ts';
import { ownerTranscriptTarget, routeOwnerNotice } from './owner-message-routing.ts';
import { ownerChatAgent } from './owner-chat.ts';
import { withRecordLock } from './record-lock.ts';
import { MessageDeliveryBody, matchesMessageReceipt } from './message-receipt.ts';

export const WorkNoticeDelivery = z.object({
  noticeID: z.string(), messageID: z.string(), origin: ChatOrigin,
  status: z.enum(['prepared', 'sent', 'uncertain', 'not-sent']),
  notice: WorkNotice.optional(),
  agent: MessageDeliveryBody.shape.agent.optional(), text: MessageDeliveryBody.shape.text.optional(), reason: z.string().optional(),
});
export type WorkNoticeDelivery = z.infer<typeof WorkNoticeDelivery>;

async function workNoticeDeliveries(runtime: Runtime) {
  const directory = join(runtime.stateDirectory, 'notices', 'delivery');
  const names = await readdir(directory).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [];
  });
  return Promise.all(names.filter(name => name.endsWith('.json')).map(async name =>
    WorkNoticeDelivery.parse(JSON.parse(await readFile(join(directory, name), 'utf8')))));
}

function save(runtime: Runtime, receipt: WorkNoticeDelivery) {
  return writeDurableFile(join(runtime.stateDirectory, 'notices', 'delivery', `${receipt.messageID}.json`), JSON.stringify(receipt));
}

function matches(message: TranscriptMessage, receipt: WorkNoticeDelivery) {
  return !!receipt.agent && !!receipt.text
    && matchesMessageReceipt(message, receipt.messageID, { agent: receipt.agent, text: receipt.text });
}

async function reconcile(runtime: Runtime, client: Parameters<Plugin>[0]['client'], receipt: WorkNoticeDelivery) {
  if (receipt.status === 'sent') {
    await claimNotice(runtime, receipt.noticeID);
    return true;
  }
  const target = await ownerTranscriptTarget(runtime, receipt.origin);
  const observed = (await transcriptClient(client).messages(target)).find(message => message.info.id === receipt.messageID);
  if (observed && !matches(observed, receipt)) throw new Error('work_notice_message_identity_conflict');
  if (observed) {
    await save(runtime, { ...receipt, status: 'sent', reason: undefined });
    await claimNotice(runtime, receipt.noticeID);
    return true;
  }
  if (receipt.status !== 'not-sent') {
    await save(runtime, { ...receipt, status: 'uncertain', reason: 'work_notice_acceptance_unconfirmed' });
    return true;
  }
  return false;
}

function noticeText(notice: WorkNotice, context: string) {
  const sender = notice.sender ? `From owner ${notice.sender.owner}. ` : '';
  const reply = notice.sender ? `Reply with onionsoup_reply message "${notice.id}" and your answer. ` : '';
  const work = notice.workItem ? `Work item ${notice.workItem}. ` : '';
  return `${NOTICE_PREFIX} Addressed work notice ${notice.id}. ${work}${sender}${reply}`
    + `This is actionable conversation, not an informational consultation or a person's approval.\n\n${notice.text}`
    + (context ? `\n\n${context}` : '');
}

async function prepare(runtime: Runtime, client: Parameters<Plugin>[0]['client'], pass: MaintenancePass, notice: WorkNotice,
  previous: WorkNoticeDelivery | undefined) {
  const owner = runtime.declarations.owners.get(notice.owner);
  if (!owner?.persona) throw new Error('work_notice_recipient_unavailable');
  const routed = await routeOwnerNotice(runtime, client, pass, { ...notice, origin: previous?.origin ?? notice.origin });
  const transport = transcriptClient(client);
  if (!await transport.idle(routed.origin)) return undefined;
  pass.check();
  const hasSameDestination = previous && JSON.stringify(previous.origin) === JSON.stringify(routed.origin);
  const receipt = hasSameDestination ? previous : WorkNoticeDelivery.parse({
    noticeID: notice.id, messageID: previous?.messageID
      ?? nextMessageId((await transport.messages(routed.origin)).map(message => message.info.id)),
    origin: routed.origin, status: 'not-sent',
    agent: ownerChatAgent(owner), text: noticeText(notice, routed.context),
    notice,
  });
  await save(runtime, receipt);
  return receipt;
}

async function send(runtime: Runtime, client: Parameters<Plugin>[0]['client'], pass: MaintenancePass, receipt: WorkNoticeDelivery) {
  if (!receipt.agent || !receipt.text) throw new Error('work_notice_delivery_body_missing');
  let attempted = false;
  try {
    pass.check();
    await save(runtime, { ...receipt, status: 'prepared', reason: undefined });
    pass.check();
    attempted = true;
    const reply = await client.session.promptAsync({ path: { id: receipt.origin.sessionID }, query: { directory: receipt.origin.directory },
      body: { agent: receipt.agent, messageID: receipt.messageID, parts: [{ type: 'text', text: receipt.text }] } });
    if (reply.error) throw new Error('work_notice_transport_rejected');
  } catch (error) {
    const status = !attempted || error instanceof MaintenanceEffectNotStarted ? 'not-sent' : 'uncertain';
    await save(runtime, { ...receipt, status, reason: error instanceof Error ? error.message : 'work_notice_transport_uncertain' });
    throw error;
  }
  await reconcile(runtime, client, { ...receipt, status: 'prepared' });
}

async function deliverNotice(runtime: Runtime, client: Parameters<Plugin>[0]['client'], pass: MaintenancePass, notice: WorkNotice) {
  // Queue identity and transport identity are independent locks; queue repair can run during a send.
  await withRecordLock(join(runtime.stateDirectory, 'notices', 'delivery-locks', `${notice.id}.lock`), async () => {
    pass.check();
    const previous = (await workNoticeDeliveries(runtime)).find(receipt => receipt.noticeID === notice.id);
    if (previous?.notice) {
      const { at: _previousAt, ...savedContent } = previous.notice;
      const { at: _nextAt, ...currentContent } = notice;
      if (JSON.stringify(savedContent) !== JSON.stringify(currentContent)) throw new Error('work_notice_identity_conflict');
    }
    if (previous && await reconcile(runtime, client, previous)) return;
    const receipt = await prepare(runtime, client, pass, notice, previous);
    if (receipt) await send(runtime, client, pass, receipt);
  });
}

/** Pending intents survive rejection/crashes. Claimed legacy receipts also reconcile without replaying an uncertain ID. */
export async function deliverWorkNotices(runtime: Runtime, client: Parameters<Plugin>[0]['client'], pass: MaintenancePass,
  onError: (id: string, error: unknown) => void = (id, error) => { console.warn('work_notice_delivery_failed', id, error); }) {
  const waiting = new Map((await pendingNotices(runtime)).map(notice => [notice.id, notice]));
  for (const receipt of await workNoticeDeliveries(runtime)) {
    if (receipt.status === 'sent' || waiting.has(receipt.noticeID)) continue;
    const notice = await readNotice(runtime, receipt.noticeID);
    if (notice) waiting.set(notice.id, notice);
  }
  for (const notice of waiting.values()) {
    pass.check();
    try { await deliverNotice(runtime, client, pass, notice); }
    catch (error) {
      pass.check();
      onError(notice.id, error);
    }
  }
}
