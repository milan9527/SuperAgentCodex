import '@testing-library/jest-dom'
import { vi } from 'vitest'

// Mock localStorage for tests — MUST be set up before any module imports
// that access localStorage at module load time (e.g., useWorkflows → getAuthToken)
// Using vi.hoisted() to ensure this runs before all imports
const localStorageMock = vi.hoisted(() => {
  const mock = {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn()
  }
  Object.defineProperty(globalThis.window ?? globalThis, 'localStorage', {
    value: mock,
    writable: true,
    configurable: true,
  })
  return mock
})

import { server } from './mocks/server'
import { resetWorkflowsStore, initializeWorkflowsStore } from '@/services/useWorkflows'

// Mock scrollIntoView for tests (not available in jsdom)
Element.prototype.scrollIntoView = vi.fn()

class ResizeObserverMock implements ResizeObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}

globalThis.ResizeObserver = ResizeObserverMock

// Establish API mocking before all tests
beforeAll(() => server.listen())

// Reset any request handlers that we may add during the tests,
// so they don't affect other tests
afterEach(() => {
  server.resetHandlers()
  localStorageMock.getItem.mockReset()
  localStorageMock.getItem.mockReturnValue(null)
  localStorageMock.setItem.mockReset()
  localStorageMock.removeItem.mockReset()
  localStorageMock.clear.mockReset()
  localStorageMock.key.mockReset()
  // Reset workflow store to ensure clean state between tests
  resetWorkflowsStore()
})

// Initialize workflow store before each test
beforeEach(() => {
  localStorageMock.getItem.mockReturnValue(null)
  // Re-initialize the workflow store after reset
  initializeWorkflowsStore()
})

// Clean up after the tests are finished
afterAll(() => server.close())
