interface ChatMessageInfo { id: string; role: string; parentID?: string; finish?: string }

/**
 * A prompt sent while a chat is busy is stored before the reply in progress (opencode orders messages by ID), so when
 * that turn ends the history the model gets ends with the assistant. Models that refuse assistant prefill (Copilot's
 * Claude) then fail, and the prompt is never answered. After a finished turn, move the prompts sent during it (after
 * the prompt it answered, with no reply of their own) to the end, in their order. Mid-turn tool steps are left alone.
 */
export function answerQueuedPrompts<Message extends { info: ChatMessageInfo }>(messages: Message[]) {
  const last = messages.at(-1)?.info;
  if (last?.role !== 'assistant' || last.finish === 'tool-calls') return;
  const answeredIndex = messages.findIndex(message => message.info.id === last.parentID);
  if (answeredIndex < 0) return;
  const answered = new Set(messages.map(message => message.info.parentID));
  const queued = messages.slice(answeredIndex + 1)
    .filter(message => message.info.role === 'user' && !answered.has(message.info.id));
  if (!queued.length) return;
  const rest = messages.filter(message => !queued.includes(message));
  messages.splice(0, messages.length, ...rest, ...queued);
}
