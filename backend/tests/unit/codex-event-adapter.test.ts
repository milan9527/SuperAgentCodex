import { describe, expect, it } from 'vitest';
import {
  adaptCodexNotification,
  createCodexAdapterState,
} from '../../src/services/codex/codex-event-adapter.js';

describe('codex-event-adapter', () => {
  it('keeps the turn active for retryable transport errors', () => {
    const state = createCodexAdapterState('thread-1', 'openai.gpt-oss-20b-1:0');
    state.turnId = 'turn-1';

    expect(adaptCodexNotification({
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: true,
        error: { message: 'Reconnecting... 1/5' },
      },
    }, state)).toEqual([]);
    expect(state.terminal).toBe(false);
  });

  it('emits ordered text deltas without duplicating completed text', () => {
    const state = createCodexAdapterState('thread-1', 'openai.gpt-5.6-sol');
    state.turnId = 'turn-1';

    const first = adaptCodexNotification({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'Hello' },
    }, state);
    const second = adaptCodexNotification({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: ' world' },
    }, state);
    const completed = adaptCodexNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'msg-1', text: 'Hello world' },
      },
    }, state);

    expect(first[0]?.content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(second[0]?.content).toEqual([{ type: 'text', text: ' world' }]);
    expect(completed).toEqual([]);
  });

  it('maps command lifecycle to matching tool ids', () => {
    const state = createCodexAdapterState('thread-1');
    state.turnId = 'turn-1';

    const started = adaptCodexNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'pwd',
          cwd: '/workspace',
          status: 'inProgress',
        },
      },
    }, state);
    const completed = adaptCodexNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'pwd',
          cwd: '/workspace',
          status: 'completed',
          aggregatedOutput: '/workspace\n',
          exitCode: 0,
        },
      },
    }, state);

    expect(started[0]?.content?.[0]).toMatchObject({
      type: 'tool_use',
      id: 'cmd-1',
      name: 'Bash',
      category: 'command',
    });
    expect(completed[0]?.content?.[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'cmd-1',
      content: '/workspace\n',
      is_error: false,
    });
  });

  it('attaches latest token usage to the terminal result', () => {
    const state = createCodexAdapterState('thread-1', 'openai.gpt-5.6-sol');
    state.turnId = 'turn-1';

    adaptCodexNotification({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          last: {
            inputTokens: 10,
            outputTokens: 5,
            cachedInputTokens: 3,
            cacheWriteInputTokens: 2,
          },
        },
      },
    }, state);
    const result = adaptCodexNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', durationMs: 42 },
      },
    }, state);

    expect(result).toEqual([expect.objectContaining({
      type: 'result',
      status: 'completed',
      durationMs: 42,
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
      },
    })]);
    expect(result[0]?.tokenUsage).not.toHaveProperty('totalCostUsd');
  });

  it('rejects cross-thread and post-terminal notifications', () => {
    const state = createCodexAdapterState('thread-1');
    state.turnId = 'turn-1';

    expect(adaptCodexNotification({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-2', turnId: 'turn-1', itemId: 'msg-1', delta: 'bad' },
    }, state)).toEqual([]);

    adaptCodexNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    }, state);

    expect(adaptCodexNotification({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'late' },
    }, state)).toEqual([]);
  });

  it('maps collaboration activity to the technical custom-agent name', () => {
    const state = createCodexAdapterState('thread-1', undefined, 'risk-reviewer');
    state.turnId = 'turn-1';

    const spawn = adaptCodexNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'collabAgentToolCall',
          id: 'collab-1',
          tool: 'spawnAgent',
          status: 'inProgress',
          receiverThreadIds: ['sub-1'],
          prompt: 'Review risk.',
        },
      },
    }, state);
    expect(spawn[0]?.content?.[0]).toMatchObject({
      type: 'tool_use',
      name: 'Task',
      input: {
        subagent_type: 'risk-reviewer',
        agent: 'risk-reviewer',
      },
    });

    const activity = adaptCodexNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'subAgentActivity',
          id: 'activity-1',
          kind: 'started',
          agentThreadId: 'sub-1',
          agentPath: '/workspace/.codex/agents/risk-reviewer.toml',
        },
      },
    }, state);
    expect(activity[0]?.content?.[0]).toMatchObject({
      type: 'tool_use',
      id: 'codex-subagent:sub-1',
      input: {
        subagent_type: 'risk-reviewer',
        agentThreadId: 'sub-1',
      },
    });

    const completed = adaptCodexNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'collabAgentToolCall',
          id: 'collab-wait',
          tool: 'wait',
          status: 'completed',
          receiverThreadIds: ['sub-1'],
          agentsStates: {
            'sub-1': { status: 'completed', message: 'Review complete.' },
          },
        },
      },
    }, state);
    expect(completed.at(-1)?.content?.[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'codex-subagent:sub-1',
      content: 'Review complete.',
      is_error: false,
    });
  });
});
