import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { modelProviderService } from '@/services/modelProviderService'
import type { ModelProvider, ModelSelection } from '@/types'
import {
  filterRuntimeCompatibleProviders,
  loadRuntimeModelsForProvider,
} from '@/services/runtimeModelCompatibility'

interface ModelSelectorProps {
  value?: ModelSelection
  onChange: (selection: ModelSelection) => void
  disabled?: boolean
  /** Label above the controls. */
  label?: string
  defaultProviderLabel?: string
  defaultModelLabel?: string
}

/**
 * Reusable provider + model picker. Lists org model providers; when a litellm
 * provider is selected it fetches that provider's model list, otherwise it
 * offers a free-text model id. Emits a { providerId, modelId } selection.
 */
export function ModelSelector({
  value,
  onChange,
  disabled,
  label,
  defaultProviderLabel = 'Org default provider',
  defaultModelLabel = 'Provider default model',
}: ModelSelectorProps) {
  const [providers, setProviders] = useState<ModelProvider[]>([])
  const [models, setModels] = useState<Array<{ id: string; litellm_model: string; provider: string }>>([])
  const [loadingModels, setLoadingModels] = useState(false)

  const providerId = value?.providerId ?? ''
  const modelId = value?.modelId ?? ''

  useEffect(() => {
    modelProviderService.list()
      .then(filterRuntimeCompatibleProviders)
      .then(setProviders)
      .catch(() => setProviders([]))
  }, [])

  useEffect(() => {
    if (!providerId) {
      setModels([])
      return
    }
    const provider = providers.find(item => item.id === providerId)
    setLoadingModels(true)
    loadRuntimeModelsForProvider(provider)
      .then(setModels)
      .catch(() => setModels([]))
      .finally(() => setLoadingModels(false))
  }, [providerId, providers])

  return (
    <div className="space-y-2">
      {label && (
        <label className="block text-xs font-medium text-gray-400">{label}</label>
      )}
      <select
        value={providerId}
        onChange={(e) => onChange({ providerId: e.target.value || undefined, modelId: undefined })}
        disabled={disabled}
        className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-blue-500 focus:outline-none appearance-none cursor-pointer disabled:opacity-50"
      >
        <option value="">{defaultProviderLabel}</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}{p.isOrgDefault ? ' ★' : ''}
          </option>
        ))}
      </select>

      {loadingModels ? (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-500">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading models...
        </div>
      ) : models.length > 0 ? (
        <select
          value={modelId}
          onChange={(e) => onChange({ providerId: providerId || undefined, modelId: e.target.value || undefined })}
          disabled={disabled}
          className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-blue-500 focus:outline-none font-mono appearance-none cursor-pointer disabled:opacity-50"
        >
          <option value="">{defaultModelLabel}</option>
          {models.map((m) => (
            <option key={m.litellm_model} value={m.litellm_model}>
              {m.id} — {m.provider}
            </option>
          ))}
        </select>
      ) : (
        <input
          value={modelId}
          onChange={(e) => onChange({ providerId: providerId || undefined, modelId: e.target.value || undefined })}
          disabled={disabled}
          placeholder={defaultModelLabel}
          className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-blue-500 focus:outline-none font-mono disabled:opacity-50"
        />
      )}
    </div>
  )
}
