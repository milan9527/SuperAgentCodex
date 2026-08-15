import { describe, expect, it } from 'vitest';
import {
  WorkflowProgressAccumulator,
  parseProgressMarkers,
} from '../../src/services/workflow-executor-v2.js';

describe('WorkflowProgressAccumulator', () => {
  const titles = new Map([['task-1', 'Audit task']]);

  it('parses progress markers split across text deltas', () => {
    const accumulator = new WorkflowProgressAccumulator(titles);

    expect(accumulator.acceptText('[STEP_COM')).toEqual([]);
    expect(accumulator.acceptText('PLETE:task-1:finished]')).toEqual([{
      type: 'step_complete',
      taskId: 'task-1',
      taskTitle: 'Audit task',
      message: 'finished',
    }]);
  });

  it('emits a step transition exactly once across MCP and text fallback', () => {
    const accumulator = new WorkflowProgressAccumulator(titles);
    const mcpEvent = {
      type: 'step_complete' as const,
      taskId: 'task-1',
      taskTitle: 'Audit task',
      message: 'from MCP',
    };

    expect(accumulator.accept(mcpEvent)).toEqual([mcpEvent]);
    expect(accumulator.acceptText('[STEP_COMPLETE:task-1:from text]')).toEqual([]);
    expect(accumulator.accept(mcpEvent)).toEqual([]);
  });

  it('parses start, complete, and failure markers', () => {
    expect(parseProgressMarkers(
      '[STEP_START:task-1][STEP_COMPLETE:task-1:ok][STEP_FAILED:task-2:no]',
      titles,
    )).toEqual([
      { type: 'step_start', taskId: 'task-1', taskTitle: 'Audit task' },
      {
        type: 'step_complete',
        taskId: 'task-1',
        taskTitle: 'Audit task',
        message: 'ok',
      },
      {
        type: 'step_failed',
        taskId: 'task-2',
        taskTitle: undefined,
        message: 'no',
      },
    ]);
  });
});
