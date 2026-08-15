import { describe, expect, it, vi } from 'vitest';
import { ClaudeAgentRuntime } from '../../src/services/agent-runtime-claude.js';
import type { ConversationEvent } from '../../src/services/agent-types.js';
import type { ClaudeAgentService } from '../../src/services/claude-agent.service.js';

function serviceWithAttempts(attempts: ConversationEvent[][]) {
  const calls: Array<{ claudeSessionId?: string; historyCount: number }> = [];
  const service = {
    async *runConversation(options: {
      claudeSessionId?: string;
      history?: unknown[];
    }) {
      calls.push({
        claudeSessionId: options.claudeSessionId,
        historyCount: options.history?.length ?? 0,
      });
      for (const event of attempts.shift() ?? []) yield event;
    },
    disconnectSession: vi.fn().mockResolvedValue(undefined),
    disconnectAll: vi.fn().mockResolvedValue(0),
    activeClientCount: 0,
    hasSession: vi.fn().mockReturnValue(false),
  } as unknown as ClaudeAgentService;
  return { service, calls };
}

const agentConfig = {
  id: 'agent-1',
  name: 'agent',
  displayName: 'Agent',
  systemPrompt: null,
  organizationId: 'org-1',
  skillIds: [],
  mcpServerIds: [],
  resolvedModel: {
    provider: 'litellm' as const,
    modelId: 'bedrock/us.anthropic.claude-sonnet-4-6',
  },
};

describe('ClaudeAgentRuntime resume recovery', () => {
  it('replays bounded history when native resume fails before any turn content', async () => {
    const { service, calls } = serviceWithAttempts([
      [
        {
          type: 'session_start',
          provider: 'claude',
          sessionId: 'stale-attempt',
          providerThreadId: 'stale-attempt',
          status: 'in_progress',
        },
        {
          type: 'result',
          provider: 'claude',
          sessionId: 'stale-attempt',
          providerThreadId: 'stale-attempt',
          status: 'failed',
          durationMs: 0,
          numTurns: 0,
        },
        {
          type: 'error',
          provider: 'claude',
          status: 'failed',
          message: 'Claude Code process exited with code 1',
        },
      ],
      [
        {
          type: 'session_start',
          provider: 'claude',
          sessionId: 'replacement-session',
          providerThreadId: 'replacement-session',
          status: 'in_progress',
        },
        {
          type: 'assistant',
          provider: 'claude',
          content: [{ type: 'text', text: 'RECOVERED' }],
        },
        {
          type: 'result',
          provider: 'claude',
          sessionId: 'replacement-session',
          providerThreadId: 'replacement-session',
          status: 'completed',
          numTurns: 1,
        },
      ],
    ]);
    const runtime = new ClaudeAgentRuntime(service);
    const events: ConversationEvent[] = [];

    for await (const event of runtime.runConversation(
      {
        agentId: 'agent-1',
        sessionId: 'platform-session',
        providerThreadId: 'missing-native-session',
        message: 'continue',
        organizationId: 'org-1',
        userId: 'user-1',
        history: [{ role: 'user', content: 'earlier request' }],
      },
      agentConfig,
      [],
    )) {
      events.push(event);
    }

    expect(calls).toEqual([
      { claudeSessionId: 'missing-native-session', historyCount: 1 },
      { claudeSessionId: undefined, historyCount: 1 },
    ]);
    expect(events).not.toContainEqual(expect.objectContaining({
      sessionId: 'stale-attempt',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'assistant',
      content: [{ type: 'text', text: 'RECOVERED' }],
    }));
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      status: 'completed',
      providerThreadId: 'replacement-session',
    });
  });

  it('keeps native resume streaming once provider content starts', async () => {
    const { service, calls } = serviceWithAttempts([[
      {
        type: 'session_start',
        provider: 'claude',
        sessionId: 'native-session',
        providerThreadId: 'native-session',
        status: 'in_progress',
      },
      {
        type: 'assistant',
        provider: 'claude',
        content: [{ type: 'text', text: 'NATIVE' }],
      },
      {
        type: 'result',
        provider: 'claude',
        providerThreadId: 'native-session',
        status: 'completed',
        numTurns: 1,
      },
    ]]);
    const runtime = new ClaudeAgentRuntime(service);
    const events: ConversationEvent[] = [];

    for await (const event of runtime.runConversation(
      {
        agentId: 'agent-1',
        sessionId: 'platform-session',
        providerThreadId: 'native-session',
        message: 'continue',
        organizationId: 'org-1',
        userId: 'user-1',
        history: [{ role: 'user', content: 'earlier request' }],
      },
      agentConfig,
      [],
    )) {
      events.push(event);
    }

    expect(calls).toHaveLength(1);
    expect(events.map(event => event.type)).toEqual([
      'session_start',
      'assistant',
      'result',
    ]);
  });
});
