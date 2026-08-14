import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CodexAppServerTransport,
  CodexNotification,
} from '../codex-app-server-client.js';
import { runAgent } from '../agent-runner.js';

class FakeTransport implements CodexAppServerTransport {
  readonly calls: Array<{ method: string; params?: unknown }> = [];
  closed = false;

  constructor(
    private readonly events: CodexNotification[],
    private readonly resumeFails = false,
  ) {}

  async start(): Promise<void> {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'thread/resume' && this.resumeFails) {
      throw new Error('thread not found');
    }
    if (method === 'thread/resume' || method === 'thread/start') {
      return { thread: { id: 'thread-new' }, model: 'openai.gpt-5.4' } as T;
    }
    if (method === 'turn/start') return { turn: { id: 'turn-1' } } as T;
    throw new Error(`Unexpected request: ${method}`);
  }

  notify(): void {}

  async *notifications(): AsyncGenerator<CodexNotification> {
    for (const event of this.events) yield event;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

test('falls back to a new Codex thread and replays bounded history', async () => {
  const transport = new FakeTransport([
    {
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-new', turnId: 'turn-1', itemId: 'msg-1', delta: 'done' },
    },
    {
      method: 'turn/completed',
      params: { threadId: 'thread-new', turnId: 'turn-1', turn: {
        id: 'turn-1',
        status: 'completed',
      }},
    },
  ], true);

  const events = [];
  for await (const event of runAgent({
    prompt: 'continue',
    provider_thread_id: 'thread-missing',
    model: 'openai.gpt-5.4',
    history: [{ role: 'user', content: 'earlier request' }],
  }, undefined, () => transport)) {
    events.push(event);
  }

  assert.deepEqual(transport.calls.map(call => call.method), [
    'thread/resume',
    'thread/start',
    'turn/start',
  ]);
  const turnParams = transport.calls[2]!.params as {
    input: Array<{ type: string; text: string }>;
  };
  assert.match(turnParams.input[0]!.text, /Recovered conversation context/);
  assert.match(turnParams.input[0]!.text, /earlier request/);
  assert.equal(events[0]?.type, 'session_start');
  assert.equal(events.at(-1)?.type, 'result');
  assert.equal(transport.closed, true);
});

test('resumes an existing thread without replaying platform history', async () => {
  const transport = new FakeTransport([{
    method: 'turn/completed',
    params: { threadId: 'thread-new', turnId: 'turn-1', turn: {
      id: 'turn-1',
      status: 'completed',
    }},
  }]);

  for await (const _event of runAgent({
    prompt: 'current',
    provider_thread_id: 'thread-existing',
    model: 'openai.gpt-5.4',
    history: [{ role: 'user', content: 'must not be replayed' }],
  }, undefined, () => transport)) {
    // consume
  }

  const turnParams = transport.calls[1]!.params as {
    input: Array<{ type: string; text: string }>;
  };
  assert.equal(turnParams.input[0]!.text, 'current');
});
