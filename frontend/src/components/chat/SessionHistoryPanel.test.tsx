import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { SessionHistoryPanel } from './SessionHistoryPanel'

function setCompactViewport(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches,
      media: '(max-width: 639px)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SessionHistoryPanel responsive defaults', () => {
  it('starts collapsed on compact viewports', () => {
    setCompactViewport(true)

    render(
      <SessionHistoryPanel
        businessScopeId={null}
        activeSessionId={null}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
      />,
    )

    expect(screen.getByTitle('Expand session history')).toBeInTheDocument()
  })

  it('starts expanded on desktop viewports', () => {
    setCompactViewport(false)

    render(
      <SessionHistoryPanel
        businessScopeId={null}
        activeSessionId={null}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
      />,
    )

    expect(screen.getByTitle('Collapse panel')).toBeInTheDocument()
  })
})
