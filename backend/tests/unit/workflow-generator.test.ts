import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '../../src/services/agent-runtime.js';
import { WorkflowGeneratorService } from '../../src/services/workflow-generator.service.js';

describe('WorkflowGeneratorService', () => {
  it('resolves the organization and scope model before invoking AgentCore', async () => {
    const observedConfigs: unknown[] = [];
    const runtime: AgentRuntime = {
      name: 'agentcore',
      async *runConversation(_options, agentConfig) {
        observedConfigs.push(agentConfig);
        yield {
          type: 'result',
          provider: 'agentcore',
          status: 'completed',
        };
      },
      disconnectSession: async () => {},
      disconnectAll: async () => 0,
      activeSessionCount: 0,
      hasSession: () => false,
    };
    const modelResolver = vi.fn().mockResolvedValue({
      provider: 'bedrock',
      modelId: 'openai.gpt-5.6-sol',
    });
    const service = new WorkflowGeneratorService({ runtime, modelResolver });

    for await (const _event of service.generate(
      'Create an incident workflow',
      {
        organizationId: 'org-1',
        scopeSettings: {
          modelSelection: {
            providerId: 'provider-1',
            modelId: 'global.openai.gpt-5.6-sol',
          },
        },
      },
    )) {
      // Consume the generator so the runtime invocation executes.
    }

    expect(modelResolver).toHaveBeenCalledWith('org-1', {
      scopeSelection: {
        providerId: 'provider-1',
        modelId: 'global.openai.gpt-5.6-sol',
      },
    });
    expect(observedConfigs).toEqual([
      expect.objectContaining({
        organizationId: 'org-1',
        model: 'openai.gpt-5.6-sol',
        resolvedModel: {
          provider: 'bedrock',
          modelId: 'openai.gpt-5.6-sol',
        },
      }),
    ]);
  });

  it('uses the same resolved model contract for workflow patches', async () => {
    const observedConfigs: unknown[] = [];
    const runtime: AgentRuntime = {
      name: 'agentcore',
      async *runConversation(_options, agentConfig) {
        observedConfigs.push(agentConfig);
        yield {
          type: 'result',
          provider: 'agentcore',
          status: 'completed',
        };
      },
      disconnectSession: async () => {},
      disconnectAll: async () => 0,
      activeSessionCount: 0,
      hasSession: () => false,
    };
    const service = new WorkflowGeneratorService({
      runtime,
      modelResolver: vi.fn().mockResolvedValue({
        provider: 'bedrock',
        modelId: 'openai.gpt-5.6-sol',
      }),
    });

    for await (const _event of service.generatePatches(
      { title: 'Workflow', tasks: [] },
      'Rename it',
      { organizationId: 'org-1' },
    )) {
      // Consume the generator so the runtime invocation executes.
    }

    expect(observedConfigs).toEqual([
      expect.objectContaining({
        id: 'workflow-patcher',
        organizationId: 'org-1',
        model: 'openai.gpt-5.6-sol',
      }),
    ]);
  });

  it('preserves human approval tasks during plan validation', () => {
    const service = new WorkflowGeneratorService();
    const plan = service.parseGeneratedPlan([{
      type: 'text',
      text: JSON.stringify({
        title: 'Incident response',
        tasks: [{
          id: 'approval',
          title: 'Incident Commander Approval',
          type: 'humanApproval',
          prompt: 'Pause for explicit approval.',
          dependentTasks: ['triage'],
        }],
        variables: [],
      }),
    }]);

    expect(plan.tasks[0]?.type).toBe('humanApproval');
  });

  it('normalizes unknown task types without changing supported Codex task types', () => {
    const service = new WorkflowGeneratorService();
    const plan = service.parseGeneratedPlan([{
      type: 'text',
      text: JSON.stringify({
        title: 'Mixed workflow',
        tasks: [
          {
            id: 'approval',
            title: 'Approval',
            type: 'humanApproval',
            prompt: 'Approve.',
            dependentTasks: [],
          },
          {
            id: 'unknown',
            title: 'Unknown',
            type: 'madeUpType',
            prompt: 'Run.',
          },
        ],
      }),
    }]);

    expect(plan.tasks.map(task => task.type)).toEqual(['humanApproval', 'agent']);
    expect(plan.tasks[1]?.dependentTasks).toEqual([]);
  });

  it('validates patch operation names and required fields', () => {
    const service = new WorkflowGeneratorService();

    expect(service.parsePatches([{
      type: 'text',
      text: JSON.stringify([
        { op: 'updateTitle', title: 'New title' },
        { op: 'relayout' },
      ]),
    }])).toHaveLength(2);

    expect(() => service.parsePatches([{
      type: 'text',
      text: JSON.stringify([{ op: 'updateTask', taskId: 'task-1' }]),
    }])).toThrow('updateTask requires taskData');

    expect(() => service.parsePatches([{
      type: 'text',
      text: JSON.stringify([{ op: 'runArbitraryCode' }]),
    }])).toThrow('unsupported operation');
  });
});
