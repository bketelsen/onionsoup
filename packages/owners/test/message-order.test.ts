import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerQueuedPrompts } from '../src/message-order.ts';

const user = (id: string) => ({ info: { id, role: 'user' } });
const assistant = (id: string, parentID: string, finish?: string) => ({ info: { id, role: 'assistant', parentID, finish } });
const ids = (messages: { info: { id: string } }[]) => messages.map(message => message.info.id);

test('a prompt sent while the chat was busy moves after the finished turn (the lost R2 question, 2026-10-02)', () => {
  const messages = [
    user('msg_1_notice'), user('msg_2_person'),
    assistant('msg_3', 'msg_1_notice', 'tool-calls'), assistant('msg_4', 'msg_1_notice', 'stop'),
  ];
  answerQueuedPrompts(messages);
  assert.deepEqual(ids(messages), ['msg_1_notice', 'msg_3', 'msg_4', 'msg_2_person']);
});

test('several queued prompts keep their order', () => {
  const messages = [user('a'), user('b'), user('c'), assistant('d', 'a', 'stop')];
  answerQueuedPrompts(messages);
  assert.deepEqual(ids(messages), ['a', 'd', 'b', 'c']);
});

test('history that already ends with a prompt, a mid-turn tool step, or older unanswered prompts is left alone', () => {
  const ordinary = [user('a'), assistant('b', 'a', 'stop'), user('c')];
  answerQueuedPrompts(ordinary);
  assert.deepEqual(ids(ordinary), ['a', 'b', 'c']);
  const midTurn = [user('a'), user('b'), assistant('c', 'a', 'tool-calls')];
  answerQueuedPrompts(midTurn);
  assert.deepEqual(ids(midTurn), ['a', 'b', 'c']);
  const aborted = [user('old'), user('a'), assistant('b', 'a', 'stop')];
  answerQueuedPrompts(aborted);
  assert.deepEqual(ids(aborted), ['old', 'a', 'b']);
});
