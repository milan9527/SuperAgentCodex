import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProvider } from '@/types'

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}))

vi.mock('./api/restClient', () => ({
  restClient: {
    get: vi.fn(),
    post: mocks.post,
    patch: mocks.patch,
    delete: mocks.delete,
  },
}))

import {
  MODEL_PROVIDERS_CHANGED_EVENT,
  modelProviderService,
} from './modelProviderService'

const provider: ModelProvider = {
  id: 'provider-1',
  name: 'Admin Provider',
  type: 'litellm',
  baseUrl: 'https://litellm.example.com',
  defaultModelId: 'claude-sonnet-4.6',
  allowedModelIds: ['claude-sonnet-4.6'],
  runtimeCompatibleModelIds: ['claude-sonnet-4.6'],
  isOrgDefault: false,
  hasApiKey: true,
  status: 'active',
  enabled: true,
  runtimeCompatible: true,
  runtimeCompatibilityReason: null,
  runtimeTarget: 'claude',
  createdAt: '',
  updatedAt: '',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('modelProviderService change notifications', () => {
  it('notifies mounted Chat views after a provider is created', async () => {
    mocks.post.mockResolvedValue(provider)
    const listener = vi.fn()
    window.addEventListener(MODEL_PROVIDERS_CHANGED_EVENT, listener)

    await modelProviderService.create({
      name: provider.name,
      type: provider.type,
      base_url: provider.baseUrl,
      default_model_id: provider.defaultModelId,
      allowed_model_ids: provider.allowedModelIds,
    })

    expect(listener).toHaveBeenCalledOnce()
    window.removeEventListener(MODEL_PROVIDERS_CHANGED_EVENT, listener)
  })

  it('notifies after enablement changes affect Chat visibility', async () => {
    mocks.patch.mockResolvedValue(provider)
    const listener = vi.fn()
    window.addEventListener(MODEL_PROVIDERS_CHANGED_EVENT, listener)

    await modelProviderService.setEnabled(provider.id, true)

    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/model-providers/${provider.id}`,
      { enabled: true },
    )
    expect(listener).toHaveBeenCalledOnce()
    window.removeEventListener(MODEL_PROVIDERS_CHANGED_EVENT, listener)
  })
})
