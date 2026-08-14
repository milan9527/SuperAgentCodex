import { describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexAgentRuntime } from '../../src/services/agent-runtime-codex.js';
import type {
  CodexAppServerTransport,
  CodexNotification,
} from '../../src/services/codex/codex-app-server-client.js';
import type { AgentConfig } from '../../src/services/agent-types.js';

class MockTransport implements CodexAppServerTransport {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  started = false;
  closed = false;
  private notificationsQueue: CodexNotification[];
  private waiting: ((value: IteratorResult<CodexNotification>) => void) | null = null;
  private readonly failResume: boolean;

  constructor(notifications: CodexNotification[] = [], options?: { failResume?: boolean }) {
    this.notificationsQueue = [...notifications];
    this.failResume = options?.failResume ?? false;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === 'thread/resume' && this.failResume) {
      throw new Error('thread/resume failed: rollout not found');
    }
    if (method === 'thread/start' || method === 'thread/resume') {
      return {
        thread: { id: method === 'thread/resume' ? 'thread-existing' : 'thread-new' },
        model: 'openai.gpt-5.6-sol',
      } as T;
    }
    if (method === 'model/list') {
      return {
        data: [{
          id: 'openai.gpt-5.6-sol',
          model: 'openai.gpt-5.6-sol',
          inputModalities: ['text', 'image'],
        }],
      } as T;
    }
    if (method === 'turn/start') return { turn: { id: 'turn-1' } } as T;
    return {} as T;
  }

  notify(): void {}

  async *notifications(): AsyncGenerator<CodexNotification> {
    for (;;) {
      const value = this.notificationsQueue.shift();
      if (value) {
        yield value;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<CodexNotification>>(resolve => {
        this.waiting = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }

  push(notification: CodexNotification): void {
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = null;
      waiting({ value: notification, done: false });
    } else {
      this.notificationsQueue.push(notification);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = null;
      waiting({ value: undefined, done: true });
    }
  }
}

const agentConfig: AgentConfig = {
  id: 'agent-1',
  name: 'agent-1',
  displayName: 'Agent 1',
  systemPrompt: 'Stay scoped.',
  organizationId: 'org-1',
  skillIds: [],
  mcpServerIds: [],
};

describe('CodexAgentRuntime', () => {
  it('starts a thread, starts a turn, and streams compatible events', async () => {
    const transport = new MockTransport([
      {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-new',
          turnId: 'turn-1',
          itemId: 'msg-1',
          delta: 'done',
        },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'thread-new',
          turn: { id: 'turn-1', status: 'completed', durationMs: 10 },
        },
      },
    ]);
    const runtime = new CodexAgentRuntime(() => transport);

    const events = [];
    for await (const event of runtime.runConversation({
      agentId: 'agent-1',
      sessionId: 'platform-session',
      message: 'hello',
      organizationId: 'org-1',
      userId: 'user-1',
      workspacePath: '/tmp/codex-runtime-test',
    }, agentConfig, [])) {
      events.push(event);
    }

    expect(events.map(event => event.type)).toEqual(['session_start', 'assistant', 'result']);
    expect(events[0]).toMatchObject({
      provider: 'codex',
      sessionId: 'thread-new',
      providerThreadId: 'thread-new',
    });
    expect(transport.requests.map(request => request.method)).toEqual(['thread/start', 'turn/start']);
    expect(transport.closed).toBe(true);
  });

  it('resumes the persisted provider thread', async () => {
    const transport = new MockTransport([{
      method: 'turn/completed',
      params: {
        threadId: 'thread-existing',
        turn: { id: 'turn-1', status: 'completed' },
      },
    }]);
    const runtime = new CodexAgentRuntime(() => transport);

    for await (const _event of runtime.runConversation({
      agentId: 'agent-1',
      sessionId: 'platform-session',
      providerThreadId: 'thread-existing',
      message: 'continue',
      organizationId: 'org-1',
      userId: 'user-1',
      workspacePath: '/tmp/codex-runtime-test',
    }, agentConfig, [])) {
      // Drain.
    }

    expect(transport.requests[0]).toMatchObject({
      method: 'thread/resume',
      params: expect.objectContaining({ threadId: 'thread-existing', excludeTurns: true }),
    });
  });

  it('interrupts an active turn by platform session id', async () => {
    const transport = new MockTransport();
    const runtime = new CodexAgentRuntime(() => transport);
    const run = (async () => {
      for await (const _event of runtime.runConversation({
        agentId: 'agent-1',
        sessionId: 'platform-session',
        message: 'wait',
        organizationId: 'org-1',
        userId: 'user-1',
        workspacePath: '/tmp/codex-runtime-test',
      }, agentConfig, [])) {
        // Drain.
      }
    })();

    await waitUntil(() => runtime.hasSession('platform-session'));
    await runtime.disconnectSession('platform-session');
    await run;

    expect(transport.requests).toContainEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-new', turnId: 'turn-1' },
    });
    expect(runtime.activeSessionCount).toBe(0);
  });

  it('starts a replacement thread with bounded platform history when resume fails', async () => {
    const transport = new MockTransport([{
      method: 'turn/completed',
      params: {
        threadId: 'thread-new',
        turn: { id: 'turn-1', status: 'completed' },
      },
    }], { failResume: true });
    const runtime = new CodexAgentRuntime(() => transport);

    for await (const _event of runtime.runConversation({
      agentId: 'agent-1',
      sessionId: 'platform-session',
      providerThreadId: 'missing-thread',
      history: [
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: 'Earlier answer' },
      ],
      message: 'continue',
      organizationId: 'org-1',
      userId: 'user-1',
      workspacePath: '/tmp/codex-runtime-test',
    }, agentConfig, [])) {
      // Drain.
    }

    expect(transport.requests.map(request => request.method)).toEqual([
      'thread/resume',
      'thread/start',
      'turn/start',
    ]);
    expect(transport.requests[2]).toMatchObject({
      method: 'turn/start',
      params: {
        threadId: 'thread-new',
        input: [expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('User: Earlier question'),
        })],
      },
    });
  });

  it('sends authorized workspace images as localImage inputs', async () => {
    const workspacePath = join(tmpdir(), `codex-image-test-${randomUUID()}`);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'evidence.png'), Buffer.from([137, 80, 78, 71]));
    const transport = new MockTransport([{
      method: 'turn/completed',
      params: {
        threadId: 'thread-new',
        turn: { id: 'turn-1', status: 'completed' },
      },
    }]);
    const runtime = new CodexAgentRuntime(() => transport);

    try {
      for await (const _event of runtime.runConversation({
        agentId: 'agent-1',
        sessionId: 'platform-session',
        message: 'inspect this image',
        imagePaths: ['evidence.png'],
        organizationId: 'org-1',
        userId: 'user-1',
        workspacePath,
      }, agentConfig, [])) {
        // Drain.
      }
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }

    expect(transport.requests.map(request => request.method)).toEqual([
      'thread/start',
      'model/list',
      'turn/start',
    ]);
    expect(transport.requests[2]).toMatchObject({
      params: {
        input: [
          expect.objectContaining({ type: 'text' }),
          { type: 'localImage', path: join(workspacePath, 'evidence.png') },
        ],
      },
    });
  });

  it('passes serializable stdio MCP servers through thread config', async () => {
    const transport = new MockTransport([{
      method: 'turn/completed',
      params: {
        threadId: 'thread-new',
        turn: { id: 'turn-1', status: 'completed' },
      },
    }]);
    const runtime = new CodexAgentRuntime(() => transport);

    for await (const _event of runtime.runConversation({
      agentId: 'agent-1',
      sessionId: 'platform-session',
      message: 'run workflow',
      organizationId: 'org-1',
      userId: 'user-1',
      workspacePath: '/tmp/codex-runtime-test',
    }, agentConfig, [], undefined, {
      'workflow-progress': {
        type: 'stdio',
        command: '/usr/bin/node',
        args: ['/app/runtime-assets/workflow-progress-server.mjs'],
        env: { EVENT_FILE: '/tmp/events.jsonl' },
      },
    })) {
      // Drain.
    }

    expect(transport.requests[0]).toMatchObject({
      method: 'thread/start',
      params: {
        config: {
          mcp_servers: {
            'workflow-progress': {
              command: '/usr/bin/node',
              args: ['/app/runtime-assets/workflow-progress-server.mjs'],
              env: { EVENT_FILE: '/tmp/events.jsonl' },
              required: true,
            },
          },
        },
      },
    });
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
