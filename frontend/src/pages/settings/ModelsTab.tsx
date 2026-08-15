import { useEffect, useState } from 'react'
import { Plus, Star, Trash2, Server, Cloud, X, RefreshCw, Pencil } from 'lucide-react'
import { modelProviderService, type CreateModelProviderInput } from '@/services/modelProviderService'
import type { ModelProvider } from '@/types'
import { useTranslation } from '@/i18n'

type ModelOption = { id: string; litellm_model: string; provider: string }

interface ModelsTabProps {
  isAdmin: boolean
}

const EMPTY_FORM: CreateModelProviderInput = {
  name: '',
  type: 'litellm',
  base_url: '',
  api_key: '',
  default_model_id: '',
  allowed_model_ids: [],
  is_org_default: false,
}

export function ModelsTab({ isAdmin }: ModelsTabProps) {
  const { t } = useTranslation()
  const [providers, setProviders] = useState<ModelProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<CreateModelProviderInput>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [formModels, setFormModels] = useState<ModelOption[]>([])
  const [formModelsLoading, setFormModelsLoading] = useState(false)

  // Live catalogs are admin-only configuration inputs. Chat never calls this
  // endpoint; it receives only the saved allowed model ids.
  const loadFormModels = async (refresh = false) => {
    setFormModelsLoading(true)
    try {
      if (form.type === 'bedrock') {
        setFormModels(await modelProviderService.listBedrockModels({ refresh }))
      } else if (editingId) {
        setFormModels(await modelProviderService.listModels(editingId, { refresh }))
      } else {
        setFormModels([])
      }
    } catch {
      setFormModels([])
    } finally {
      setFormModelsLoading(false)
    }
  }

  // Refresh the form model list when the form opens or the type changes.
  useEffect(() => {
    if (!showForm) return
    void loadFormModels(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showForm, form.type, editingId])

  const load = async () => {
    setLoading(true)
    try {
      setProviders(await modelProviderService.list())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load providers')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const openCreate = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setShowForm(true)
  }

  const openEdit = (p: ModelProvider) => {
    setEditingId(p.id)
    setForm({
      name: p.name,
      type: p.type,
      base_url: p.baseUrl ?? '',
      api_key: '', // write-only; blank keeps the existing key
      default_model_id: p.defaultModelId ?? '',
      allowed_model_ids: p.allowedModelIds,
      is_org_default: p.isOrgDefault,
    })
    setShowForm(true)
  }

  const closeForm = () => {
    setShowForm(false)
    setEditingId(null)
    setForm(EMPTY_FORM)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      if (editingId) {
        // Edit: type is immutable; api_key is only sent when the admin typed a new one.
        await modelProviderService.update(editingId, {
          name: form.name.trim(),
          base_url: form.type === 'litellm' ? form.base_url?.trim() || null : null,
          ...(form.type === 'litellm' && form.api_key?.trim()
            ? { api_key: form.api_key.trim() }
            : {}),
          default_model_id: form.default_model_id?.trim() || null,
          allowed_model_ids: form.allowed_model_ids ?? [],
          is_org_default: form.is_org_default,
        })
      } else {
        await modelProviderService.create({
          name: form.name.trim(),
          type: form.type,
          base_url: form.type === 'litellm' ? form.base_url?.trim() || null : null,
          api_key: form.type === 'litellm' ? form.api_key?.trim() || null : null,
          default_model_id: form.default_model_id?.trim() || null,
          allowed_model_ids: form.allowed_model_ids?.length
            ? form.allowed_model_ids
            : form.default_model_id?.trim()
              ? [form.default_model_id.trim()]
              : [],
          is_org_default: form.is_org_default,
        })
      }
      closeForm()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save provider')
    } finally {
      setSaving(false)
    }
  }

  const handleSetDefault = async (id: string) => {
    try {
      await modelProviderService.setDefault(id)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set default')
    }
  }

  const handleToggleEnabled = async (id: string, enabled: boolean) => {
    try {
      await modelProviderService.setEnabled(id, enabled)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update provider')
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm(t('models.confirmDelete'))) return
    try {
      await modelProviderService.remove(id)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete provider')
    }
  }

  const allowedModelIds = form.allowed_model_ids ?? []
  const canSubmit =
    form.name.trim().length > 0 &&
    (form.type !== 'litellm' || (form.base_url?.trim().length ?? 0) > 0) &&
    allowedModelIds.length > 0 &&
    !!form.default_model_id &&
    allowedModelIds.includes(form.default_model_id)

  const updateDefaultModel = (modelId: string) => {
    setForm(current => {
      const currentAllowed = current.allowed_model_ids ?? []
      const shouldReplaceSingleDefault =
        currentAllowed.length === 0 ||
        (currentAllowed.length === 1 && currentAllowed[0] === current.default_model_id)
      return {
        ...current,
        default_model_id: modelId,
        allowed_model_ids: shouldReplaceSingleDefault
          ? modelId ? [modelId] : []
          : currentAllowed,
      }
    })
  }

  const toggleAllowedModel = (modelId: string) => {
    setForm(current => {
      const currentAllowed = current.allowed_model_ids ?? []
      const allowed = currentAllowed.includes(modelId)
        ? currentAllowed.filter(id => id !== modelId)
        : [...currentAllowed, modelId]
      const defaultModel = allowed.includes(current.default_model_id ?? '')
        ? current.default_model_id
        : allowed[0] ?? ''
      return {
        ...current,
        allowed_model_ids: allowed,
        default_model_id: defaultModel,
      }
    })
  }

  const selectableModels = Array.from(
    new Map(
      [
        ...formModels,
        ...allowedModelIds.map(modelId => ({
          id: modelId,
          litellm_model: modelId,
          provider: form.type,
        })),
      ].map(model => [model.litellm_model, model]),
    ).values(),
  )

  return (
    <div className="max-w-3xl">
      <div className="flex items-start justify-between mb-1">
        <h2 className="text-lg font-semibold text-white">{t('models.title')}</h2>
        {isAdmin && !showForm && (
          <button
            onClick={openCreate}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white"
          >
            <Plus className="w-4 h-4" />
            {t('models.add')}
          </button>
        )}
      </div>
      <p className="text-sm text-gray-400 mb-6">{t('models.subtitle')}</p>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
          {error}
        </div>
      )}

      {showForm && (
        <div className="mb-6 p-4 rounded-xl border border-gray-700 bg-gray-800/50 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-gray-200">
              {editingId ? t('models.editProvider') : t('models.add')}
            </h3>
            <button onClick={closeForm} className="text-gray-400 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-gray-400">
              {t('models.name')}
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="mt-1 w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-700 text-white text-sm"
                placeholder="Corp LiteLLM"
              />
            </label>
            <label className="text-xs text-gray-400">
              {t('models.type')}
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as 'bedrock' | 'litellm' })}
                disabled={!!editingId}
                className="mt-1 w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-700 text-white text-sm disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <option value="litellm">LiteLLM Gateway</option>
                <option value="bedrock">Amazon Bedrock</option>
              </select>
            </label>
          </div>
          {form.type === 'litellm' && (
            <>
              <label className="block text-xs text-gray-400">
                {t('models.baseUrl')}
                <input
                  value={form.base_url ?? ''}
                  onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                  className="mt-1 w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-700 text-white text-sm"
                  placeholder="https://litellm.example.com"
                />
              </label>
              <label className="block text-xs text-gray-400">
                {t('models.apiKey')}
                <input
                  type="password"
                  value={form.api_key ?? ''}
                  onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                  className="mt-1 w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-700 text-white text-sm"
                  placeholder={editingId ? '••••••••' : 'sk-...'}
                  autoComplete="new-password"
                />
                {editingId && (
                  <span className="mt-1 block text-[11px] text-gray-500">{t('models.apiKeyKeepHint')}</span>
                )}
              </label>
            </>
          )}
          <div className="block text-xs text-gray-400">
            <div className="flex items-center justify-between">
              <span>{t('models.allowedModels')}</span>
              {(form.type === 'bedrock' || editingId) && (
                <button
                  type="button"
                  onClick={() => loadFormModels(true)}
                  disabled={formModelsLoading}
                  className="flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 disabled:opacity-50"
                  title={t('models.refreshModels')}
                >
                  <RefreshCw className={`w-3 h-3 ${formModelsLoading ? 'animate-spin' : ''}`} />
                  {t('models.refreshModels')}
                </button>
              )}
            </div>
            {formModels.length > 0 ? (
              <div className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 p-2 space-y-1">
                {selectableModels.map(model => (
                  <label
                    key={model.litellm_model}
                    className="flex items-center gap-2 px-2 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
                  >
                    <input
                      type="checkbox"
                      checked={allowedModelIds.includes(model.litellm_model)}
                      onChange={() => toggleAllowedModel(model.litellm_model)}
                    />
                    <span className="font-mono break-all">{model.litellm_model}</span>
                  </label>
                ))}
              </div>
            ) : (
              <textarea
                value={allowedModelIds.join('\n')}
                onChange={(event) => {
                  const ids = event.target.value
                    .split(/[\n,]/)
                    .map(id => id.trim())
                    .filter(Boolean)
                  setForm(current => ({
                    ...current,
                    allowed_model_ids: ids,
                    default_model_id: ids.includes(current.default_model_id ?? '')
                      ? current.default_model_id
                      : ids[0] ?? '',
                  }))
                }}
                rows={3}
                className="mt-1 w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-700 text-white text-sm font-mono"
                placeholder={form.type === 'bedrock' ? 'openai.gpt-5.4' : 'claude-sonnet-4.6'}
              />
            )}
            {!editingId && form.type === 'litellm' && (
              <span className="mt-1 block text-[11px] text-gray-500">
                {t('models.allowedModelsCreateHint')}
              </span>
            )}
          </div>
          <label className="block text-xs text-gray-400">
            {t('models.defaultModelId')}
            {allowedModelIds.length > 0 ? (
              <select
                value={form.default_model_id ?? ''}
                onChange={(event) => updateDefaultModel(event.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-700 text-white text-sm font-mono"
              >
                {allowedModelIds.map(modelId => (
                  <option key={modelId} value={modelId}>
                    {modelId}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={form.default_model_id ?? ''}
                onChange={(event) => updateDefaultModel(event.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-700 text-white text-sm font-mono"
                placeholder={form.type === 'bedrock' ? 'openai.gpt-5.4' : 'claude-sonnet-4.6'}
              />
            )}
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input
              type="checkbox"
              checked={form.is_org_default}
              onChange={(e) => setForm({ ...form, is_org_default: e.target.checked })}
            />
            {t('models.setDefault')}
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={closeForm}
              className="px-3 py-1.5 text-sm rounded-lg border border-gray-700 text-gray-300 hover:bg-gray-800"
            >
              {t('common.cancel')}
            </button>
            <button
              disabled={!canSubmit || saving}
              onClick={handleSave}
              className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
            >
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-gray-500">{t('common.loading')}</div>
      ) : (
        <div className="space-y-2">
          {providers.map((p) => (
            <div
              key={p.id}
              className={`flex items-center justify-between p-4 rounded-xl border border-gray-700 bg-gray-800/50 ${p.enabled ? '' : 'opacity-50'}`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-gray-400">
                  {p.type === 'bedrock' ? <Cloud className="w-5 h-5" /> : <Server className="w-5 h-5" />}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-200 truncate">{p.name}</span>
                    {p.isOrgDefault && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 font-medium">
                        {t('models.default')}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 truncate">
                    {p.type === 'litellm' ? p.baseUrl : 'Amazon Bedrock'}
                    {p.defaultModelId ? ` · ${p.defaultModelId}` : ''}
                    {` · ${p.allowedModelIds.length} ${t('models.allowedCount')}`}
                    {p.type === 'litellm' && p.hasApiKey ? ' · 🔑' : ''}
                  </div>
                </div>
              </div>
              {isAdmin && (
                <div className="flex items-center gap-1 shrink-0">
                  {/* Edit provider (name, base_url, api_key, default model, org default) */}
                  <button
                    onClick={() => openEdit(p)}
                    title={t('models.edit')}
                    className="p-2 text-gray-400 hover:text-blue-400"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  {/* Enable/disable toggle (any provider; the org keeps >=1 enabled) */}
                  <button
                    role="switch"
                    aria-checked={p.enabled}
                    onClick={() => handleToggleEnabled(p.id, !p.enabled)}
                    title={t('models.enabledToggle')}
                    className={`relative w-9 h-5 rounded-full transition-colors mr-1 shrink-0 ${p.enabled ? 'bg-blue-600' : 'bg-gray-600'}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${p.enabled ? 'translate-x-4' : 'translate-x-0'}`} />
                  </button>
                  {!p.isOrgDefault && (
                    <button
                      onClick={() => handleSetDefault(p.id)}
                      title={t('models.setDefault')}
                      className="p-2 text-gray-400 hover:text-yellow-400"
                    >
                      <Star className="w-4 h-4" />
                    </button>
                  )}
                  {!p.isOrgDefault && (
                    <button
                      onClick={() => handleDelete(p.id)}
                      title={t('common.delete')}
                      className="p-2 text-gray-400 hover:text-red-400"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
