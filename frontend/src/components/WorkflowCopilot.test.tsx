import { describe, expect, it } from 'vitest'
import { mergeExecutionLogStep } from './WorkflowCopilot'

describe('WorkflowCopilot execution logs', () => {
  it('merges adjacent streaming log deltas into one step', () => {
    const first = mergeExecutionLogStep([], 'Japan')
    const second = mergeExecutionLogStep(first, 'ese ')
    const third = mergeExecutionLogStep(second, 'Amazon.co.jp')

    expect(third).toEqual([{
      type: 'execution_log',
      content: 'Japanese Amazon.co.jp',
    }])
  })

  it('preserves execution boundaries around node events', () => {
    const steps = mergeExecutionLogStep([
      { type: 'execution_log', content: 'first block' },
      {
        type: 'execution_node',
        taskId: 'task-1',
        status: 'completed',
      },
    ], 'second block')

    expect(steps).toEqual([
      { type: 'execution_log', content: 'first block' },
      {
        type: 'execution_node',
        taskId: 'task-1',
        status: 'completed',
      },
      { type: 'execution_log', content: 'second block' },
    ])
  })
})
