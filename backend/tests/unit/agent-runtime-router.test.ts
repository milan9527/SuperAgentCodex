import { describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntime,
  AgentRuntimeOptions,
} from '../../src/services/agent-runtime.js';
import type {
  AgentConfig,
  ConversationEvent,
} from '../../src/services/agent-types.js';
import {
  ModelRoutingAgentRuntime,
  UnsupportedAgentModelError,
} from '../../src/services/agent-runtime-router.js';

function fakeRuntime(name: string): AgentRuntime {
  return {
    name,
    async *runConversation(): AsyncGenerator<ConversationEvent> {
      yield { type: 'result', provider: name as ConversationEvent['provider'], status: 'completed' };
    },
    disconnectSession: vi.fn().mockResolvedValue(undefined),
    disconnectAll: vi.fn().mockResolvedValue(0),
    activeSessionCount: 0,
    hasSession: vi.fn().mockReturnValue(false),
  };
}

function agentConfig(
  provider: 'bedrock' | 'litellm',
  modelId: string,
): AgentConfig {
  return {
    id: 'agent-1',
    name: 'agent-1',
    displayName: 'Agent 1',
    systemPrompt: null,
    organizationId: 'org-1',
    skillIds: [],
    mcpServerIds: [],
    model: modelId,
    resolvedModel: { provider, modelId },
  };
}

describe('ModelRoutingAgentRuntime', () => {
  it('keeps Bedrock GPT models on the native Codex/AgentCore runtime', () => {
    const primary = fakeRuntime('agentcore');
    const claude = fakeRuntime('claude');
    const router = new ModelRoutingAgentRuntime(primary, claude);

    expect(router.resolveRuntime(agentConfig('bedrock', 'openai.gpt-5.4'))).toBe(primary);
  });

  it('routes the LiteLLM model catalog through Claude Agent SDK', () => {
    const primary = fakeRuntime('agentcore');
    const claude = fakeRuntime('claude');
    const router = new ModelRoutingAgentRuntime(primary, claude);

    expect(
      router.resolveRuntime(agentConfig('litellm', 'anthropic/claude-sonnet-4-6')),
    ).toBe(claude);
  });

  it('rejects direct Bedrock Claude instead of silently replacing it with GPT', () => {
    const router = new ModelRoutingAgentRuntime(
      fakeRuntime('agentcore'),
      fakeRuntime('claude'),
    );

    try {
      router.resolveRuntime(agentConfig('bedrock', 'us.anthropic.claude-sonnet-4-6'));
      throw new Error('Expected direct Bedrock Claude to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedAgentModelError);
      expect(error).toMatchObject({
        statusCode: 400,
        code: 'AGENT_MODEL_RUNTIME_UNSUPPORTED',
      });
    }
  });

  it('delegates cancellation to both runtimes because the active model may have switched', async () => {
    const primary = fakeRuntime('agentcore');
    const claude = fakeRuntime('claude');
    const router = new ModelRoutingAgentRuntime(primary, claude);

    await router.disconnectSession('session-1');

    expect(primary.disconnectSession).toHaveBeenCalledWith('session-1');
    expect(claude.disconnectSession).toHaveBeenCalledWith('session-1');
  });
});
