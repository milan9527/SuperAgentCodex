/**
 * Customer Service Section for ScopeProfile
 * 
 * Provides: service toggle, Widget configuration, FAQ management overview,
 * service quality metrics, and test widget launcher.
 */

import { useState, useEffect, useCallback } from 'react'
import { Headphones, Power, Copy, ExternalLink, BookOpen, BarChart3, Plus, Check, RefreshCw, Eye } from 'lucide-react'
import { restClient } from '@/services/api/restClient'
import { RestSupportService, type FaqArticle, type MetricsSummary } from '@/services/api/restSupportService'
import type { BusinessScope } from '@/services/businessScopeService'
import { TestWidget } from './TestWidget'
import { translations } from '@/i18n/translations'

/** Module-level t() — no React context dependency */
function t(key: string): string {
  const lang = (typeof window !== 'undefined' && localStorage.getItem('super-agent-language')) || 'en'
  const entry = (translations as Record<string, { en: string; cn: string }>)[key]
  if (!entry) return key
  return entry[lang as 'en' | 'cn'] ?? entry.en ?? key
}

interface CustomerServiceSectionProps {
  scope: BusinessScope
}

interface WidgetApiKey {
  id: string
  name: string
  keyPrefix: string
  apiKey?: string // Only available on creation
}

export function CustomerServiceSection({ scope }: CustomerServiceSectionProps) {
  const [isEnabled, setIsEnabled] = useState(false)
  const [widgetKey, setWidgetKey] = useState<WidgetApiKey | null>(null)
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null)
  const [faqStats, setFaqStats] = useState<{ published: number; drafts: number }>({ published: 0, drafts: 0 })
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [showTestWidget, setShowTestWidget] = useState(false)
  const [showFaqForm, setShowFaqForm] = useState(false)
  const [copied, setCopied] = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      // Check if there's an existing widget API key for this scope
      const keysRes = await restClient.get<{ data: Array<{ id: string; name: string; keyPrefix: string; scopes: string[]; isActive: boolean }> }>('/api/api-keys')
      const widgetKeys = keysRes.data.filter(k => 
        k.scopes.includes('widget:connect') && k.name.includes(scope.id.substring(0, 8)) && k.isActive
      )
      
      if (widgetKeys.length > 0) {
        setWidgetKey({ id: widgetKeys[0]!.id, name: widgetKeys[0]!.name, keyPrefix: widgetKeys[0]!.keyPrefix })
        setIsEnabled(true)
      }

      // Load FAQ stats
      const [publishedRes, draftsRes] = await Promise.all([
        RestSupportService.getFaqArticles({ status: 'published', businessScopeId: scope.id }),
        RestSupportService.getFaqArticles({ status: 'draft', businessScopeId: scope.id }),
      ])
      setFaqStats({ published: publishedRes.total, drafts: draftsRes.total })

      // Load metrics
      const metricsData = await RestSupportService.getMetricsSummary()
      setMetrics(metricsData)
    } catch (err) {
      console.error('Failed to load CS data:', err)
    } finally {
      setLoading(false)
    }
  }, [scope.id])

  useEffect(() => { loadData() }, [loadData])

  const handleToggleService = async () => {
    if (isEnabled) {
      // Disable: we just hide the UI, don't delete the key
      setIsEnabled(false)
    } else {
      // Enable: create a widget API key if none exists
      if (!widgetKey) {
        try {
          const res = await restClient.post<{ apiKey: string; data: { id: string; name: string; keyPrefix: string } }>(
            '/api/api-keys',
            {
              name: `Widget - ${scope.name} (${scope.id.substring(0, 8)})`,
              scopes: ['widget:connect'],
              rateLimitPerMinute: 120,
            }
          )
          setWidgetKey({ id: res.data.id, name: res.data.name, keyPrefix: res.data.keyPrefix, apiKey: res.apiKey })
          setNewKeyValue(res.apiKey)
        } catch (err) {
          console.error('Failed to create widget API key:', err)
          return
        }
      }
      setIsEnabled(true)
    }
  }

  const handleCopyKey = () => {
    const key = newKeyValue ?? `${widgetKey?.keyPrefix}...`
    navigator.clipboard.writeText(key)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleCreateFaq = async (question: string, answer: string, category: string) => {
    await RestSupportService.createFaqArticle({
      question, answer, category: category || undefined, businessScopeId: scope.id,
    })
    setShowFaqForm(false)
    loadData()
  }

  if (loading) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden p-4">
        <div className="flex items-center gap-2">
          <Headphones className="w-4 h-4 text-gray-400" />
          <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">{t('cs.title')}</h3>
        </div>
        <div className="py-4 text-center text-xs text-gray-500">Loading...</div>
      </div>
    )
  }

  return (
    <>
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Headphones className="w-4 h-4 text-blue-400" />
            <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">{t('cs.title')}</h3>
          </div>
          <button
            onClick={handleToggleService}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors ${
              isEnabled
                ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
            }`}
          >
            <Power className="w-3 h-3" />
            {isEnabled ? t('cs.online') : t('cs.offline')}
          </button>
        </div>

        {isEnabled ? (
          <>
            {/* Live Stats */}
            {metrics && (
              <div className="grid grid-cols-3 gap-2 mb-4">
                <div className="bg-gray-800/50 rounded-lg p-2 text-center">
                  <div className="text-lg font-bold text-white">{metrics.totalConversations}</div>
                  <div className="text-[9px] text-gray-500">{t('cs.conversations')}</div>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-2 text-center">
                  <div className="text-lg font-bold text-green-400">{(metrics.aiResolvedRate * 100).toFixed(0)}%</div>
                  <div className="text-[9px] text-gray-500">{t('cs.aiResolved')}</div>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-2 text-center">
                  <div className="text-lg font-bold text-yellow-400">{metrics.avgCsatRating > 0 ? metrics.avgCsatRating.toFixed(1) : 'N/A'}</div>
                  <div className="text-[9px] text-gray-500">{t('cs.csat')}</div>
                </div>
              </div>
            )}

            {/* Widget Configuration */}
            <div className="mb-4 p-3 bg-gray-800/50 rounded-lg border border-gray-700/50">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-gray-400 font-medium uppercase">{t('cs.widgetApiKey')}</span>
                <button onClick={handleCopyKey} className="flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300">
                  {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  {copied ? t('cs.copied') : t('cs.copy')}
                </button>
              </div>
              <code className="text-[11px] text-gray-300 font-mono block truncate">
                {newKeyValue ?? `${widgetKey?.keyPrefix ?? 'sk_'}${'•'.repeat(20)}`}
              </code>
              {newKeyValue && (
                <p className="text-[9px] text-yellow-500 mt-1">{t('cs.saveKeyWarning')}</p>
              )}
            </div>

            {/* Actions */}
            <div className="flex gap-2 mb-4">
              <button
                onClick={() => setShowTestWidget(true)}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 rounded-lg text-[11px] font-medium transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                {t('cs.testWidget')}
              </button>
              <button
                onClick={() => setShowFaqForm(true)}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-purple-600/20 hover:bg-purple-600/30 text-purple-400 rounded-lg text-[11px] font-medium transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('cs.addFaq')}
              </button>
            </div>

            {/* FAQ Overview */}
            <div className="p-3 bg-gray-800/50 rounded-lg border border-gray-700/50">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <BookOpen className="w-3.5 h-3.5 text-gray-400" />
                  <span className="text-[10px] text-gray-400 font-medium uppercase">{t('cs.faqKnowledgeBase')}</span>
                </div>
                <span className="text-[10px] text-gray-500">{faqStats.published} {t('cs.published')} · {faqStats.drafts} {t('cs.drafts')}</span>
              </div>
              {faqStats.published === 0 && faqStats.drafts === 0 ? (
                <p className="text-[10px] text-gray-600 italic">{t('cs.noFaqYet')}</p>
              ) : (
                <div className="w-full bg-gray-700 rounded-full h-1.5">
                  <div
                    className="bg-green-500 h-1.5 rounded-full transition-all"
                    style={{ width: `${Math.min(100, faqStats.published * 10)}%` }}
                  />
                </div>
              )}
            </div>
          </>
        ) : (
          /* Disabled state */
          <div className="text-center py-4">
            <Headphones className="w-8 h-8 text-gray-700 mx-auto mb-2" />
            <p className="text-xs text-gray-500">{t('cs.enableDescription')}</p>
            <p className="text-[10px] text-gray-600 mt-1">{t('cs.enableHint')}</p>
          </div>
        )}
      </div>

      {/* FAQ Creation Form Modal */}
      {showFaqForm && (
        <FaqCreateModal
          onSubmit={handleCreateFaq}
          onClose={() => setShowFaqForm(false)}
        />
      )}

      {/* Test Widget Floating Panel */}
      {showTestWidget && widgetKey && (
        <TestWidget
          scopeId={scope.id}
          scopeName={scope.name}
          apiKeyPrefix={widgetKey.keyPrefix}
          apiKey={newKeyValue ?? undefined}
          onClose={() => setShowTestWidget(false)}
        />
      )}
    </>
  )
}

// ============================================================================
// FAQ Create Modal
// ============================================================================
function FaqCreateModal({ onSubmit, onClose }: {
  onSubmit: (question: string, answer: string, category: string) => void
  onClose: () => void
}) {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [category, setCategory] = useState('')

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-800 rounded-xl p-6 w-[480px] border border-white/10" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-4">{t('cs.addFaqTitle')}</h3>
        <div className="mb-3">
          <label className="block text-sm text-gray-400 mb-1">{t('cs.question')}</label>
          <input
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            value={question} onChange={e => setQuestion(e.target.value)}
            placeholder="e.g. How do I reset my password?"
          />
        </div>
        <div className="mb-3">
          <label className="block text-sm text-gray-400 mb-1">{t('cs.answer')}</label>
          <textarea
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 h-24"
            value={answer} onChange={e => setAnswer(e.target.value)}
            placeholder="Provide a clear, helpful answer..."
          />
        </div>
        <div className="mb-4">
          <label className="block text-sm text-gray-400 mb-1">{t('cs.category')}</label>
          <select
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
            value={category} onChange={e => setCategory(e.target.value)}
          >
            <option value="">General</option>
            <option value="billing">Billing</option>
            <option value="technical">Technical</option>
            <option value="account">Account</option>
            <option value="product">Product</option>
            <option value="shipping">Shipping</option>
            <option value="returns">Returns</option>
          </select>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white">{t('cs.cancel')}</button>
          <button
            onClick={() => onSubmit(question, answer, category)}
            disabled={!question.trim() || !answer.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg text-sm transition-colors"
          >
            {t('cs.createFaq')}
          </button>
        </div>
      </div>
    </div>
  )
}
