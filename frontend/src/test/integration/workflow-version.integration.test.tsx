import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Routes, Route } from 'react-router-dom'
import { AppShell } from '@/components'
import { WorkflowEditor } from '@/pages'
import { render } from '../app-utils'

function TestWorkflowApp() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<WorkflowEditor />} />
        <Route path="/workflow" element={<WorkflowEditor />} />
      </Routes>
    </AppShell>
  )
}

async function renderEditor() {
  const user = userEvent.setup()
  render(<TestWorkflowApp />, { initialEntries: ['/workflow'] })
  await screen.findByRole('heading', { name: 'Customer Support Escalation' })
  return user
}

describe('Workflow editor integration', () => {
  it('loads workflows and renders legacy action nodes without crashing', async () => {
    await renderEditor()

    expect(screen.getByText('Support Ticket')).toBeInTheDocument()
    expect(screen.getByText('Classify Priority')).toBeInTheDocument()
    expect(screen.queryByText('error.title')).not.toBeInTheDocument()
  })

  it('keeps the selected workflow aligned between sidebar and editor', async () => {
    await renderEditor()

    await waitFor(() => {
      expect(screen.getAllByText('Customer Support Escalation')).toHaveLength(2)
      expect(
        screen.getByRole('heading', { name: 'Customer Support Escalation' }),
      ).toBeInTheDocument()
    })
  })

  it('opens the version selector for the selected workflow', async () => {
    const user = await renderEditor()
    const versionButton = screen.getByRole('button', { name: /version:/i })
    const currentVersion = versionButton.textContent?.match(/Version:\s*(\d+(?:\.\d+)+)/)?.[1]

    await user.click(versionButton)

    expect(currentVersion).toBeTruthy()
    expect(screen.getAllByText(currentVersion!, { exact: true }).length).toBeGreaterThan(0)
  })

  it('accepts natural-language instructions in the copilot', async () => {
    const user = await renderEditor()
    const input = screen.getByPlaceholderText(/generate, modify, or ask/i)

    await user.type(input, 'Add an approval step')

    expect(input).toHaveValue('Add an approval step')
  })

  it('opens the image importer and accepts an image file', async () => {
    const user = await renderEditor()
    const importButton = screen.getByTitle('Import from Image')

    await user.click(importButton)

    expect(screen.getByText('Import Workflow from Image')).toBeInTheDocument()
    const fileInput = screen.getByLabelText(/upload image/i) as HTMLInputElement
    const file = new File(['image'], 'workflow.png', { type: 'image/png' })
    await user.upload(fileInput, file)

    expect(fileInput.files?.[0]).toBe(file)
  })
})
