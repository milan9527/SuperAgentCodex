import { describe, expect, it } from 'vitest'
import type { ModelProvider } from '@/types'
import {
  filterRuntimeCompatibleProviders,
  loadRuntimeModelGroups,
  loadRuntimeModelsForProvider,
} from './runtimeModelCompatibility'

function provider(
  id: string,
  overrides: Partial<ModelProvider> = {},
): ModelProvider {
  return {
    id,
    name: id,
    type: 'bedrock',
    baseUrl: null,
    defaultModelId: 'openai.gpt-5.4',
    allowedModelIds: ['openai.gpt-5.4'],
    runtimeCompatibleModelIds: ['openai.gpt-5.4'],
    isOrgDefault: false,
    hasApiKey: false,
    status: 'active',
    enabled: true,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

describe('runtime model compatibility', () => {
  it('hides disabled and backend-marked incompatible providers', () => {
    const result = filterRuntimeCompatibleProviders([
      provider('compatible', { runtimeCompatible: true }),
      provider('incompatible', { runtimeCompatible: false }),
      provider('disabled', { enabled: false }),
      provider('legacy-without-flag'),
    ])

    expect(result.map(item => item.id)).toEqual([
      'compatible',
      'legacy-without-flag',
    ])
  })

  it('uses only the models enabled by Admin Settings', async () => {
    const bedrock = provider('bedrock')
    const litellm = provider('litellm', {
      type: 'litellm',
      defaultModelId: 'fallback-claude',
      allowedModelIds: ['fallback-claude', 'claude-haiku'],
      runtimeCompatibleModelIds: ['fallback-claude', 'claude-haiku'],
      runtimeTarget: 'claude',
    })

    const result = await loadRuntimeModelGroups([bedrock, litellm])

    expect(result[0]?.models.map(model => model.litellm_model)).toEqual(['openai.gpt-5.4'])
    expect(result[1]?.models.map(model => model.litellm_model)).toEqual([
      'fallback-claude',
      'claude-haiku',
    ])
  })

  it('does not query Bedrock catalogs or expose an incompatible provider', async () => {
    const bedrock = provider('bedrock')
    const incompatible = provider('bedrock-claude', {
      defaultModelId: 'us.anthropic.claude-sonnet-4-6',
      allowedModelIds: ['us.anthropic.claude-sonnet-4-6'],
      runtimeCompatibleModelIds: [],
      runtimeCompatible: false,
    })

    await expect(loadRuntimeModelsForProvider(bedrock)).resolves.toEqual([
      {
        id: 'openai.gpt-5.4',
        litellm_model: 'openai.gpt-5.4',
        provider: 'bedrock',
      },
    ])
    await expect(loadRuntimeModelsForProvider(incompatible)).resolves.toEqual([])
  })
})
