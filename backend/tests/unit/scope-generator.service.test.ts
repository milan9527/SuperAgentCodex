import { describe, expect, it, vi } from 'vitest';
import type {
  AgentConfig,
  AgentRuntime,
  AgentRuntimeOptions,
  ConversationEvent,
} from '../../src/services/agent-runtime.js';
import { ScopeGeneratorService } from '../../src/services/scope-generator.service.js';

describe('ScopeGeneratorService model routing', () => {
  it('resolves the requester organization model before invoking the runtime', async () => {
    let receivedOptions: AgentRuntimeOptions | undefined;
    let receivedConfig: AgentConfig | undefined;
    const runtime = {
      name: 'agentcore',
      async *runConversation(options: AgentRuntimeOptions, agentConfig: AgentConfig) {
        receivedOptions = options;
        receivedConfig = agentConfig;
        yield {
          type: 'error',
          code: 'TEST_STOP',
          message: 'stop after invocation capture',
        } as ConversationEvent;
      },
      disconnectSession: vi.fn(),
      disconnectAll: vi.fn().mockResolvedValue(0),
      activeSessionCount: 0,
      hasSession: vi.fn().mockReturnValue(false),
    } satisfies AgentRuntime;
    const modelResolver = vi.fn().mockResolvedValue({
      provider: 'bedrock',
      modelId: 'openai.gpt-5.6-sol',
    });
    const service = new ScopeGeneratorService({ runtime, modelResolver });

    const events: ConversationEvent[] = [];
    for await (const event of service.generate(
      'Create a release engineering scope',
      { organizationId: 'org-123', userId: 'user-456' },
    )) {
      events.push(event);
    }

    expect(modelResolver).toHaveBeenCalledWith('org-123', {});
    expect(receivedOptions).toMatchObject({
      organizationId: 'org-123',
      userId: 'user-456',
      scopeId: 'system',
    });
    expect(receivedConfig).toMatchObject({
      organizationId: 'org-123',
      model: 'openai.gpt-5.6-sol',
      resolvedModel: {
        provider: 'bedrock',
        modelId: 'openai.gpt-5.6-sol',
      },
    });
    expect(events).toHaveLength(1);
  });

  it('uses the same requester model routing for digital twin generation', async () => {
    let receivedOptions: AgentRuntimeOptions | undefined;
    let receivedConfig: AgentConfig | undefined;
    const runtime = {
      name: 'agentcore',
      async *runConversation(options: AgentRuntimeOptions, agentConfig: AgentConfig) {
        receivedOptions = options;
        receivedConfig = agentConfig;
        yield {
          type: 'error',
          code: 'TEST_STOP',
          message: 'stop after invocation capture',
        } as ConversationEvent;
      },
      disconnectSession: vi.fn(),
      disconnectAll: vi.fn().mockResolvedValue(0),
      activeSessionCount: 0,
      hasSession: vi.fn().mockReturnValue(false),
    } satisfies AgentRuntime;
    const modelResolver = vi.fn().mockResolvedValue({
      provider: 'bedrock',
      modelId: 'openai.gpt-5.6-sol',
    });
    const service = new ScopeGeneratorService({ runtime, modelResolver });

    for await (const _event of service.generateTwin(
      {
        displayName: 'Release Engineer',
        role: 'Release Engineering',
        description: 'Automates software delivery',
      },
      { organizationId: 'org-123', userId: 'user-456' },
    )) {
      // Consume the stream so the runtime invocation completes.
    }

    expect(modelResolver).toHaveBeenCalledWith('org-123', {});
    expect(receivedOptions).toMatchObject({
      organizationId: 'org-123',
      userId: 'user-456',
    });
    expect(receivedConfig?.resolvedModel).toEqual({
      provider: 'bedrock',
      modelId: 'openai.gpt-5.6-sol',
    });
  });
});
