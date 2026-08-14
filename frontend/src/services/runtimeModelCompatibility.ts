import type { ModelProvider } from '@/types'

export function filterRuntimeCompatibleProviders(
  providers: ModelProvider[],
): ModelProvider[] {
  return providers.filter(
    provider => provider.enabled && provider.runtimeCompatible !== false,
  )
}
