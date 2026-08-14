import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../app-utils'
import { Routes, Route } from 'react-router-dom'
import { AppShell } from '@/components'
import { Chat } from '@/pages'
import { BusinessScopeService } from '@/services/businessScopeService'

function TestChatApp() {
  return (
    <AppShell>
      <Routes>
        <Route path="/chat" element={<Chat />} />
      </Routes>
    </AppShell>
  )
}

function renderChat() {
  return render(<TestChatApp />, { initialEntries: ['/chat'] })
}

describe('Chat page integration', () => {
  beforeEach(() => {
    BusinessScopeService.resetStore?.()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the empty state when no scope or independent agent is available', async () => {
    vi.spyOn(BusinessScopeService, 'getBusinessScopes').mockResolvedValue([])

    renderChat()

    expect(await screen.findByRole('heading', { name: 'Start a Conversation' })).toBeInTheDocument()
    expect(screen.getByText(/choose a business scope or an independent agent/i)).toBeInTheDocument()
  })

  it('automatically selects the default scope and renders the composer', async () => {
    renderChat()

    expect(await screen.findByRole('button', { name: /customer support/i })).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/type your message/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Group Chat' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument()
  })

  it('searches and switches business scopes from the unified selector', async () => {
    const user = userEvent.setup()
    renderChat()

    const selector = await screen.findByRole('button', { name: /customer support/i })
    await user.click(selector)

    const search = screen.getByPlaceholderText('Search scopes or agents...')
    await user.type(search, 'Marketing')

    expect(screen.getByText('Marketing').closest('button')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /information technology/i })).not.toBeInTheDocument()

    await user.clear(search)
    await user.click(screen.getByRole('button', { name: /information technology/i }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /information technology/i })).toBeInTheDocument()
    })
  })

  it('enables sending only after the composer has content', async () => {
    const user = userEvent.setup()
    renderChat()

    const input = await screen.findByPlaceholderText(/type your message/i)
    const send = screen.getByRole('button', { name: 'Send' })

    expect(send).toBeDisabled()
    await user.type(input, 'Explain the current workspace status')
    expect(input).toHaveValue('Explain the current workspace status')
    expect(send).toBeEnabled()
  })
})
