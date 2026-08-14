import { beforeEach, describe, expect, it, vi } from 'vitest'

const { streamChatMock, postMock } = vi.hoisted(() => ({
  streamChatMock: vi.fn(),
  postMock: vi.fn(),
}))

vi.mock('@/services/chatStreamService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/chatStreamService')>()
  return {
    ...actual,
    streamChat: streamChatMock,
  }
})

vi.mock('@/services/api/restClient', () => ({
  restClient: {
    post: postMock,
  },
  getAuthToken: () => null,
}))

import { SessionStreamManager } from './SessionStreamManager'

describe('SessionStreamManager Codex interactions', () => {
  beforeEach(() => {
    streamChatMock.mockReset()
    postMock.mockReset()
  })

  it('submits image-only turns without inventing text', () => {
    streamChatMock.mockReturnValue({
      abort: vi.fn(),
      sessionId: Promise.resolve('session-1'),
    })
    const manager = new SessionStreamManager()

    manager.sendMessage('session-1', '', {
      businessScopeId: 'scope-1',
      sopContext: '',
      attachedImages: ['evidence.png'],
    })

    expect(streamChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '',
        attachedImages: ['evidence.png'],
      }),
      expect.any(Object),
    )
    expect(manager.getSession('session-1').messages[0]).toMatchObject({
      type: 'user',
      content: '',
      attachedImages: [expect.stringContaining('path=evidence.png')],
    })
  })

  it('interrupts the backend provider turn before aborting browser SSE', async () => {
    const abort = vi.fn()
    const order: string[] = []
    streamChatMock.mockReturnValue({
      abort: () => {
        order.push('abort')
        abort()
      },
      sessionId: Promise.resolve('session-1'),
    })
    postMock.mockImplementation(async () => {
      order.push('stop')
      return {}
    })
    const manager = new SessionStreamManager()
    manager.sendMessage('session-1', 'wait', {
      businessScopeId: 'scope-1',
      sopContext: '',
    })

    await manager.stopStream('session-1')

    expect(postMock).toHaveBeenCalledWith('/api/chat/sessions/session-1/stop')
    expect(order).toEqual(['stop', 'abort'])
    expect(abort).toHaveBeenCalledOnce()
    expect(manager.getSession('session-1')).toMatchObject({
      isSending: false,
      streamHandle: null,
    })
  })

  it('merges adjacent Codex text deltas into one rendered content block', () => {
    let callbacks: {
      onAssistant: (event: {
        type: 'assistant'
        content: Array<{ type: 'text'; text: string }>
      }) => void
    } | undefined
    streamChatMock.mockImplementation((_options, streamCallbacks) => {
      callbacks = streamCallbacks
      return {
        abort: vi.fn(),
        sessionId: Promise.resolve('session-1'),
      }
    })
    const manager = new SessionStreamManager()

    manager.sendMessage('session-1', 'hello', {
      businessScopeId: 'scope-1',
      sopContext: '',
    })
    callbacks!.onAssistant({
      type: 'assistant',
      content: [{ type: 'text', text: 'FR' }],
    })
    callbacks!.onAssistant({
      type: 'assistant',
      content: [{ type: 'text', text: 'ONTEND' }],
    })

    const assistant = manager.getSession('session-1').messages[1]
    expect(JSON.parse(assistant.content)).toEqual([
      { type: 'text', text: 'FRONTEND' },
    ])
  })
})
