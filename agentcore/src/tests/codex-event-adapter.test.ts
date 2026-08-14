import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adaptCodexNotification,
  createCodexAdapterState,
} from '../codex-event-adapter.js';

test('keeps a turn active for retryable transport errors', () => {
  const state = createCodexAdapterState('thread-1', 'openai.gpt-5.4');
  state.turnId = 'turn-1';
  const events = adaptCodexNotification({
    method: 'error',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: true,
      error: { message: 'Reconnecting... 1/5' },
    },
  }, state);
  assert.deepEqual(events, []);
  assert.equal(state.terminal, false);
});

test('maps command tools, usage, and terminal result', () => {
  const state = createCodexAdapterState('thread-1', 'openai.gpt-5.4');
  state.turnId = 'turn-1';

  const started = adaptCodexNotification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'commandExecution', id: 'tool-1', command: 'pwd', cwd: '/workspace' },
    },
  }, state);
  assert.equal(started[0]?.content?.[0]?.type, 'tool_use');

  adaptCodexNotification({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-1',
      tokenUsage: { last: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 3 } },
    },
  }, state);
  const completed = adaptCodexNotification({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      turn: { id: 'turn-1', status: 'completed', durationMs: 123 },
    },
  }, state);

  assert.equal(completed.at(-1)?.type, 'result');
  assert.equal(completed.at(-1)?.token_usage?.input_tokens, 10);
  assert.equal(completed.at(-1)?.provider_thread_id, 'thread-1');
  assert.equal(completed.at(-1)?.provider_turn_id, 'turn-1');
});
