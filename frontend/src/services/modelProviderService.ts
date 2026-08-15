/**
 * Model Provider service — CRUD for reusable per-org LLM providers.
 * API keys are write-only; the server never returns them (only `hasApiKey`).
 */

import { restClient } from './api/restClient'
import type { ModelProvider } from '@/types'

export const MODEL_PROVIDERS_CHANGED_EVENT = 'super-agent:model-providers-changed'

function notifyModelProvidersChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(MODEL_PROVIDERS_CHANGED_EVENT))
}

export interface CreateModelProviderInput {
  name: string
  type: 'bedrock' | 'litellm'
  base_url?: string | null
  api_key?: string | null
  default_model_id?: string | null
  allowed_model_ids?: string[]
  is_org_default?: boolean
}

export type UpdateModelProviderInput = Partial<
  Pick<CreateModelProviderInput, 'name' | 'base_url' | 'api_key' | 'default_model_id' | 'allowed_model_ids' | 'is_org_default'>
>

export const modelProviderService = {
  async list(): Promise<ModelProvider[]> {
    const res = await restClient.get<{ data: ModelProvider[] }>('/api/model-providers')
    return res.data ?? []
  },

  async create(input: CreateModelProviderInput): Promise<ModelProvider> {
    const provider = await restClient.post<ModelProvider>('/api/model-providers', input)
    notifyModelProvidersChanged()
    return provider
  },

  async update(id: string, input: UpdateModelProviderInput): Promise<ModelProvider> {
    const provider = await restClient.patch<ModelProvider>(`/api/model-providers/${id}`, input)
    notifyModelProvidersChanged()
    return provider
  },

  async remove(id: string): Promise<void> {
    await restClient.delete(`/api/model-providers/${id}`)
    notifyModelProvidersChanged()
  },

  async setDefault(id: string): Promise<ModelProvider> {
    const provider = await restClient.post<ModelProvider>(`/api/model-providers/${id}/default`)
    notifyModelProvidersChanged()
    return provider
  },

  async setEnabled(id: string, enabled: boolean): Promise<ModelProvider> {
    const provider = await restClient.patch<ModelProvider>(`/api/model-providers/${id}`, { enabled })
    notifyModelProvidersChanged()
    return provider
  },

  /** List models for a provider (litellm gateway or live Bedrock region list). */
  async listModels(
    providerId?: string,
    opts?: { refresh?: boolean },
  ): Promise<Array<{ id: string; litellm_model: string; provider: string }>> {
    const params = new URLSearchParams()
    if (providerId) params.set('providerId', providerId)
    if (opts?.refresh) params.set('refresh', 'true')
    const qs = params.toString() ? `?${params.toString()}` : ''
    const res = await restClient.get<{ data: Array<{ id: string; litellm_model: string; provider: string }> }>(
      `/api/litellm/models${qs}`,
    )
    return res.data ?? []
  },

  /** List live AWS Bedrock models for the region (no provider row required). */
  async listBedrockModels(opts?: { refresh?: boolean }): Promise<Array<{ id: string; litellm_model: string; provider: string }>> {
    const qs = opts?.refresh ? '?bedrock=true&refresh=true' : '?bedrock=true'
    const res = await restClient.get<{ data: Array<{ id: string; litellm_model: string; provider: string }> }>(
      `/api/litellm/models${qs}`,
    )
    return res.data ?? []
  },
}
