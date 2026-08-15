import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '../../src/services/agent-runtime.js';
import type { WorkspaceManager } from '../../src/services/workspace-manager.js';

const { chatCompletion } = vi.hoisted(() => ({
  chatCompletion: vi.fn(),
}));

vi.mock('../../src/services/ai.service.js', () => ({
  aiService: { chatCompletion },
}));

vi.mock('../../src/services/agent-status.service.js', () => ({
  agentStatusService: {
    withBusyStatus: async (
      _agentId: string,
      _organizationId: string,
      operation: () => Promise<unknown>,
    ) => operation(),
  },
}));

import { AgentNodeExecutor } from '../../src/services/node-executors/agent-executor.js';

describe('AgentNodeExecutor Codex failure policy', () => {
  it('does not silently fall back to direct Bedrock when AgentCore Codex fails', async () => {
    const runtime: AgentRuntime = {
      name: 'agentcore',
      async *runConversation() {
        yield {
          type: 'error',
          provider: 'agentcore',
          status: 'failed',
          message: 'tool execution failed',
        };
      },
      disconnectSession: async () => {},
      disconnectAll: async () => 0,
      activeSessionCount: 0,
      hasSession: () => false,
    };
    const workspaceManager = {
      ensureWorkspace: vi.fn().mockResolvedValue('/tmp/workflow-agent'),
    } as unknown as WorkspaceManager;
    const executor = new AgentNodeExecutor({
      runtime,
      workspaceManager,
      skillLoader: async () => [],
      modelResolver: async () => ({ provider: 'bedrock', modelId: 'openai.gpt-5.4' }),
    });

    const result = await executor.execute({
      node: {
        id: 'node-1',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: {
          title: 'Codex task',
          contentPreview: 'Use the configured tools.',
          metadata: {
            agentId: 'agent-1',
            agent: { id: 'agent-1', name: 'Codex Agent' },
          },
        },
      },
      context: {
        executionId: 'execution-1',
        nodeId: 'node-1',
        organizationId: 'org-1',
        userId: 'user-1',
        nodeOutputs: new Map(),
        variables: new Map(),
      },
    });

    expect(result).toMatchObject({
      success: false,
      error: 'Agent runtime execution failed: tool execution failed',
    });
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it('routes a LiteLLM-configured agent node through the Claude runtime', async () => {
    const primaryRun = vi.fn();
    const claudeRun = vi.fn();
    const primary: AgentRuntime = {
      name: 'agentcore',
      async *runConversation() {
        primaryRun();
      },
      disconnectSession: async () => {},
      disconnectAll: async () => 0,
      activeSessionCount: 0,
      hasSession: () => false,
    };
    const claude: AgentRuntime = {
      name: 'claude',
      async *runConversation(_options, agentConfig) {
        claudeRun(agentConfig);
        yield {
          type: 'assistant',
          provider: 'claude',
          content: [{ type: 'text', text: 'CLAUDE_WORKFLOW_OK' }],
        };
        yield { type: 'result', provider: 'claude', status: 'completed' };
      },
      disconnectSession: async () => {},
      disconnectAll: async () => 0,
      activeSessionCount: 0,
      hasSession: () => false,
    };
    const { ModelRoutingAgentRuntime } = await import('../../src/services/agent-runtime-router.js');
    const runtime = new ModelRoutingAgentRuntime(primary, claude);
    const executor = new AgentNodeExecutor({
      runtime,
      workspaceManager: {
        ensureWorkspace: vi.fn().mockResolvedValue('/tmp/workflow-agent'),
      } as unknown as WorkspaceManager,
      skillLoader: async () => [],
      modelResolver: async () => ({
        provider: 'litellm',
        modelId: 'bedrock/us.anthropic.claude-sonnet-4-6',
        baseUrl: 'https://litellm.example.test',
        apiKey: 'secret',
      }),
    });

    const result = await executor.execute({
      node: {
        id: 'node-claude',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: {
          title: 'Claude task',
          contentPreview: 'Use Claude.',
          metadata: {
            agentId: 'agent-claude',
            agent: { id: 'agent-claude', name: 'Claude Agent' },
            modelConfig: {
              provider: 'LiteLLM',
              modelId: 'bedrock/us.anthropic.claude-sonnet-4-6',
              modelSelection: {
                providerId: 'litellm-provider',
                modelId: 'bedrock/us.anthropic.claude-sonnet-4-6',
              },
            },
          },
        },
      },
      context: {
        executionId: 'execution-claude',
        nodeId: 'node-claude',
        organizationId: 'org-1',
        userId: 'user-1',
        nodeOutputs: new Map(),
        variables: new Map(),
      },
    });

    expect(result).toMatchObject({
      success: true,
      output: {
        response: 'CLAUDE_WORKFLOW_OK',
        executionMode: 'claude-runtime',
      },
    });
    expect(primaryRun).not.toHaveBeenCalled();
    expect(claudeRun).toHaveBeenCalledWith(expect.objectContaining({
      resolvedModel: expect.objectContaining({
        provider: 'litellm',
        modelId: 'bedrock/us.anthropic.claude-sonnet-4-6',
      }),
    }));
  });
});
