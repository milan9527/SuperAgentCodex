import type { ModelProvider } from '@/types'

export interface RuntimeModelOption {
  id: string
  litellm_model: string
  provider: string
}

export interface RuntimeModelGroup {
  provider: ModelProvider
  models: RuntimeModelOption[]
}

export function filterRuntimeCompatibleProviders(
  providers: ModelProvider[],
): ModelProvider[] {
  return providers.filter(
    provider => provider.enabled && provider.runtimeCompatible !== false,
  )
}

export async function loadRuntimeModelGroups(
  providers: ModelProvider[],
): Promise<RuntimeModelGroup[]> {
  return filterRuntimeCompatibleProviders(providers).map(provider => ({
    provider,
    models: runtimeModels(provider),
  }))
}

export async function loadRuntimeModelsForProvider(
  provider: ModelProvider | undefined,
): Promise<RuntimeModelOption[]> {
  if (!provider || provider.enabled === false || provider.runtimeCompatible === false) {
    return []
  }
  return runtimeModels(provider)
}

function runtimeModels(provider: ModelProvider): RuntimeModelOption[] {
  const configured = provider.runtimeCompatibleModelIds?.length
    ? provider.runtimeCompatibleModelIds
    : provider.allowedModelIds?.length
      ? provider.allowedModelIds
      : provider.defaultModelId
        ? [provider.defaultModelId]
        : []
  return configured.map(modelId => ({
    id: modelId,
    litellm_model: modelId,
    provider: provider.type,
  }))
}
