import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Maximize2, Minimize2, ExternalLink, Star, Play, Clock, Tag, User, ChevronDown, Heart, Trash2 } from 'lucide-react'
import { restClient } from '@/services/api/restClient'
import { useFavorites } from '@/hooks/useFavorites'
import { useTranslation } from '@/i18n'

// ============================================================================
// Types
// ============================================================================

interface PublishedApp {
  id: string
  name: string
  description: string | null
  icon: string
  category: string
  version: string
  status: string
  entry_point: string
  published_at: string
  metadata: Record<string, unknown>
  avg_rating?: number
  rating_count?: number
  launch_count?: number
  author_name?: string
  tags?: string[]
}

interface Review {
  id: string
  user_name: string
  rating: number
  comment: string
  created_at: string
}

interface VersionEntry {
  version: string
  changelog: string
  created_at: string
}

// ============================================================================
// Sub-components
// ============================================================================

function StarRating({ rating, size = 'sm' }: { rating: number; size?: 'sm' | 'md' }) {
  const cls = size === 'md' ? 'w-4 h-4' : 'w-3 h-3'
  return (
    <div className="flex">
      {[1, 2, 3, 4, 5].map(i => (
        <Star key={i} className={`${cls} ${i <= Math.round(rating) ? 'text-yellow-400 fill-yellow-400' : 'text-gray-600'}`} />
      ))}
    </div>
  )
}

function RatingBreakdown({ reviews }: { reviews: Review[] }) {
  const counts = [0, 0, 0, 0, 0]
  reviews.forEach(r => { if (r.rating >= 1 && r.rating <= 5) counts[r.rating - 1]++ })
  const max = Math.max(...counts, 1)
  return (
    <div className="space-y-1">
      {[5, 4, 3, 2, 1].map(star => (
        <div key={star} className="flex items-center gap-2 text-xs">
          <span className="text-gray-500 w-3">{star}</span>
          <Star className="w-3 h-3 text-yellow-400 fill-yellow-400" />
          <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
            <div className="h-full bg-yellow-400 rounded-full" style={{ width: `${(counts[star - 1] / max) * 100}%` }} />
          </div>
          <span className="text-gray-600 w-4 text-right">{counts[star - 1]}</span>
        </div>
      ))}
    </div>
  )
}

// ============================================================================
// AppRunner (Detail + Runner)
// ============================================================================

export function AppRunner() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { favorites, toggle: toggleFav } = useFavorites()
  const { t } = useTranslation()
  const [app, setApp] = useState<PublishedApp | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [reviews, setReviews] = useState<Review[]>([])
  const [versions, setVersions] = useState<VersionEntry[]>([])
  const [deleting, setDeleting] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const token = localStorage.getItem('local_auth_token') || localStorage.getItem('cognito_id_token')
  const baseUrl = import.meta.env.VITE_API_BASE_URL ?? ''

  useEffect(() => {
    if (!id) return
    setLoading(true)

    // Fetch from API
    restClient.get<PublishedApp>(`/api/apps/${id}`)
      .then(data => {
        setApp(data)
        setReviews([])
        setVersions([{ version: data.version, changelog: 'Published', created_at: data.published_at }])
      })
      .catch(() => setApp(null))
      .finally(() => setLoading(false))
  }, [id])

  const handleDelete = useCallback(async () => {
    if (!app) return
    setDeleting(true)
    try {
      await restClient.delete(`/api/apps/${app.id}`)
      navigate('/marketplace', { replace: true })
    } catch {
      setDeleting(false)
      setShowDeleteConfirm(false)
    }
  }, [app, navigate])

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-gray-500">{t('appRunner.loading')}</div>
  }

  if (!app) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3">
        <p className="text-gray-400">{t('appRunner.notFound')}</p>
        <button onClick={() => navigate('/marketplace')} className="text-blue-400 text-sm hover:underline">{t('appRunner.backToMarketplace')}</button>
      </div>
    )
  }

  const staticUrl = `${baseUrl}/api/apps/${app.id}/static/${app.entry_point}?token=${encodeURIComponent(token || '')}`

  // Running mode — full iframe
  if (running) {
    return (
      <div className={`flex flex-col h-full ${fullscreen ? 'fixed inset-0 z-50 bg-gray-950' : ''}`}>
        <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-800 bg-gray-900/80 flex-shrink-0">
          <button onClick={() => setRunning(false)} className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="text-lg">{app.icon}</span>
          <h2 className="text-sm font-semibold text-white truncate flex-1">{app.name}</h2>
          <span className="text-[10px] text-gray-600">v{app.version}</span>
          <button onClick={() => window.open(staticUrl, '_blank')} className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors" title={t('appRunner.openInNewTab')}>
            <ExternalLink className="w-4 h-4" />
          </button>
          <button onClick={() => setFullscreen(f => !f)} className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors">
            {fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>
        <iframe src={staticUrl} className="flex-1 w-full border-0 bg-white" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" title={app.name} />
      </div>
    )
  }

  // Detail page
  const daysAgo = Math.floor((Date.now() - new Date(app.published_at).getTime()) / 86400000)
  const publishedLabel = daysAgo === 0 ? 'today' : daysAgo === 1 ? 'yesterday' : `${daysAgo} days ago`

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-800 flex-shrink-0">
        <button onClick={() => navigate('/marketplace')} className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <span className="text-gray-600 text-sm">{t('appRunner.backToMarketplace')}</span>
      </div>

      <div className="max-w-4xl mx-auto w-full px-6 py-8 space-y-8">
        {/* Hero */}
        <div className="flex items-start gap-5">
          <div className="w-20 h-20 bg-gray-800 border border-gray-700 rounded-2xl flex items-center justify-center text-4xl flex-shrink-0">
            {app.icon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-2xl font-bold text-white">{app.name}</h1>
            </div>
            <div className="flex items-center gap-3 text-sm text-gray-400 mb-3">
              {app.author_name && <span className="flex items-center gap-1"><User className="w-3.5 h-3.5" /> {app.author_name}</span>}
              <span>v{app.version}</span>
              <span className="capitalize">{app.category}</span>
              <span>{t('appRunner.published')} {publishedLabel}</span>
            </div>
            <div className="flex items-center gap-4 mb-4">
              {app.avg_rating && (
                <div className="flex items-center gap-2">
                  <StarRating rating={app.avg_rating} size="md" />
                  <span className="text-sm text-gray-400">{app.avg_rating.toFixed(1)} ({app.rating_count} {t('appRunner.ratings')})</span>
                </div>
              )}
              {app.launch_count != null && (
                <span className="text-sm text-gray-500">{app.launch_count} {t('appRunner.runs')}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setRunning(true)}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-purple-600 text-white font-medium hover:bg-purple-500 transition-colors"
              >
                <Play className="w-4 h-4 fill-white" />
                {t('appRunner.runApp')}
              </button>
              <button
                onClick={() => app && toggleFav(app.id)}
                className={`p-2.5 rounded-lg border transition-colors ${
                  app && favorites.has(app.id)
                    ? 'border-red-500/50 bg-red-500/10 text-red-400'
                    : 'border-gray-700 text-gray-500 hover:text-red-400 hover:border-red-500/30'
                }`}
                title={app && favorites.has(app.id) ? t('appRunner.removeFromFav') : t('appRunner.addToFav')}
              >
                <Heart className={`w-5 h-5 ${app && favorites.has(app.id) ? 'fill-red-400' : ''}`} />
              </button>
              <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="p-2.5 rounded-lg border border-gray-700 text-gray-500 hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10 transition-colors"
                  title={t('appRunner.deleteApp')}
                >
                  <Trash2 className="w-5 h-5" />
                </button>
            </div>
          </div>
        </div>

        {/* Screenshot placeholder */}
        <div className="w-full h-48 bg-gray-800 border border-gray-700 rounded-xl flex items-center justify-center">
          <div className="text-center">
            <span className="text-5xl block mb-2">{app.icon}</span>
            <span className="text-gray-600 text-sm">{t('appRunner.screenshotPreview')}</span>
          </div>
        </div>

        {/* Description */}
        <div>
          <h2 className="text-sm font-semibold text-white mb-2">{t('appRunner.about')}</h2>
          <p className="text-gray-400 text-sm leading-relaxed">{app.description}</p>
          {app.tags && app.tags.length > 0 && (
            <div className="flex items-center gap-2 mt-3">
              <Tag className="w-3.5 h-3.5 text-gray-600" />
              {app.tags.map(tag => (
                <span key={tag} className="text-[11px] px-2 py-0.5 rounded-full bg-gray-800 border border-gray-700 text-gray-400">#{tag}</span>
              ))}
            </div>
          )}
        </div>

        {/* Reviews */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Rating breakdown */}
          <div>
            <h2 className="text-sm font-semibold text-white mb-3">{t('appRunner.ratingsTitle')}</h2>
            {app.avg_rating ? (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <span className="text-3xl font-bold text-white">{app.avg_rating.toFixed(1)}</span>
                  <div>
                    <StarRating rating={app.avg_rating} size="md" />
                    <span className="text-xs text-gray-500">{app.rating_count} {t('appRunner.ratings')}</span>
                  </div>
                </div>
                <RatingBreakdown reviews={reviews} />
              </div>
            ) : (
              <p className="text-gray-600 text-sm">{t('appRunner.noRatings')}</p>
            )}
          </div>

          {/* Reviews list */}
          <div className="md:col-span-2">
            <h2 className="text-sm font-semibold text-white mb-3">{t('appRunner.reviews')}</h2>
            {reviews.length === 0 ? (
              <p className="text-gray-600 text-sm">{t('appRunner.noReviews')}</p>
            ) : (
              <div className="space-y-3">
                {reviews.map(review => (
                  <div key={review.id} className="bg-gray-800 border border-gray-700 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <StarRating rating={review.rating} />
                      <span className="text-xs text-white font-medium">{review.user_name}</span>
                      <span className="text-[10px] text-gray-600">
                        {Math.floor((Date.now() - new Date(review.created_at).getTime()) / 86400000)}d ago
                      </span>
                    </div>
                    <p className="text-sm text-gray-400">{review.comment}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Version history */}
        <div>
          <h2 className="text-sm font-semibold text-white mb-3">{t('appRunner.versionHistory')}</h2>
          <div className="space-y-2">
            {versions.map((v, i) => (
              <div key={v.version} className="flex items-start gap-3">
                <div className="flex flex-col items-center">
                  <div className={`w-2.5 h-2.5 rounded-full ${i === 0 ? 'bg-purple-500' : 'bg-gray-600'}`} />
                  {i < versions.length - 1 && <div className="w-px h-6 bg-gray-700" />}
                </div>
                <div className="pb-2">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-medium ${i === 0 ? 'text-white' : 'text-gray-400'}`}>v{v.version}</span>
                    {i === 0 && <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-600/20 text-purple-400">LATEST</span>}
                    <span className="text-[10px] text-gray-600">
                      {new Date(v.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">{v.changelog}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowDeleteConfirm(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-white font-semibold">{t('appRunner.deleteTitle')}</h3>
                <p className="text-xs text-gray-500">{t('appRunner.deleteWarning')}</p>
              </div>
            </div>
            <p className="text-sm text-gray-400 mb-6">
              {t('appRunner.deleteConfirm')} <span className="text-white">{app?.name}</span>{t('appRunner.deleteConfirmSuffix')}
            </p>
            <div className="flex items-center gap-3 justify-end">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
                disabled={deleting}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm bg-red-600 text-white hover:bg-red-500 transition-colors disabled:opacity-50"
              >
                <Trash2 className="w-4 h-4" />
                {deleting ? t('appRunner.deleting') : t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
