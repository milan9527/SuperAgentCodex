import { describe, expect, it } from 'vitest'
import type { ModelProvider } from '@/types'
import { filterRuntimeCompatibleProviders } from './runtimeModelCompatibility'

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
})
