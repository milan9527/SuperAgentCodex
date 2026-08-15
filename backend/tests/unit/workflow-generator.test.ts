import { describe, expect, it } from 'vitest';
import { WorkflowGeneratorService } from '../../src/services/workflow-generator.service.js';

describe('WorkflowGeneratorService', () => {
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
