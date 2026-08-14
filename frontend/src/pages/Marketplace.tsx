import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search, Star, TrendingUp, Play, GitFork, ExternalLink,
  Trash2, Heart, Crown, Sparkles, Trophy, Rocket,
  Grid3X3, List, ArrowUpDown, Globe
} from 'lucide-react'
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
  published_at: string
  metadata: Record<string, unknown>
  avg_rating?: number
  rating_count?: number
  launch_count?: number
  fork_count?: number
  author_name?: string
  author_avatar?: string
  tags?: string[]
  screenshots?: string[]
  prompt?: string
}

interface Challenge {
  id: string
  title: string
  description: string
  deadline: string
  participants: number
  reward?: string
}

interface Creator {
  id: string
  name: string
  avatar?: string
  app_count: number
  total_runs: number
  rank: number
}

// ============================================================================
// Constants
// ============================================================================

const CATEGORIES = ['all', 'tool', 'dashboard', 'game', 'utility', 'form', 'other']
type SortOption = 'popular' | 'newest' | 'rating' | 'name'

// ============================================================================
// Sub-components
// ============================================================================

function StarRating({ rating, count }: { rating: number; count: number }) {
  const full = Math.floor(rating)
  const half = rating - full >= 0.5
  return (
    <div className="flex items-center gap-1">
      <div className="flex">
        {[1, 2, 3, 4, 5].map(i => (
          <Star
            key={i}
            className={`w-3 h-3 ${i <= full ? 'text-yellow-400 fill-yellow-400' : i === full + 1 && half ? 'text-yellow-400 fill-yellow-400/50' : 'text-gray-600'}`}
          />
        ))}
      </div>
      <span className="text-[10px] text-gray-500">{rating.toFixed(1)}</span>
      {count > 0 && <span className="text-[10px] text-gray-600">({count})</span>}
    </div>
  )
}

/** Banner: Create App + Weekly Challenge */
function MarketplaceBanner({ challenge, onCreateApp, onJoinChallenge }: {
  challenge: Challenge | null
  onCreateApp: () => void
  onJoinChallenge: (id: string) => void
}) {
  return (
    <div className="space-y-4">
      {/* Create App Banner */}
      <div className="relative overflow-hidden rounded-xl bg-gradient-to-r from-purple-900/60 via-indigo-900/40 to-gray-900 border border-purple-500/20 p-5">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-purple-500/10 via-transparent to-transparent" />
        <div className="relative flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Rocket className="w-5 h-5 text-purple-400" />
              AI App Marketplace
            </h2>
            <p className="text-sm text-gray-400 mt-1">发现、运行和分享 AI 驱动的应用</p>
          </div>
          <button
            onClick={onCreateApp}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium transition-all hover:scale-105 shadow-lg shadow-purple-500/20"
          >
            <Sparkles className="w-4 h-4" />
            创建新 App
          </button>
        </div>
      </div>

      {/* Weekly Challenge */}
      {challenge && (
        <div className="rounded-xl bg-gradient-to-r from-amber-900/30 via-orange-900/20 to-gray-900 border border-amber-500/20 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-amber-500/20 flex items-center justify-center">
                <Trophy className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">{challenge.title}</h3>
                <p className="text-xs text-gray-400 mt-0.5">
                  <span className="text-amber-400 font-medium">{challenge.participants}</span> 人参与
                  {challenge.reward && <> · 奖励: <span className="text-amber-400">{challenge.reward}</span></>}
                  {challenge.deadline && <> · 截止: <span className="text-gray-300">{new Date(challenge.deadline).toLocaleDateString()}</span></>}
                </p>
              </div>
            </div>
            <button
              onClick={() => onJoinChallenge(challenge.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600/80 hover:bg-amber-500 text-white text-xs font-medium transition-colors"
            >
              🚀 参加挑战
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Trending Apps Section */
function TrendingSection({ apps, onAppClick }: { apps: PublishedApp[]; onAppClick: (app: PublishedApp) => void }) {
  if (apps.length === 0) return null
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <TrendingUp className="w-4 h-4 text-orange-400" />
        <h2 className="text-sm font-semibold text-white">🔥 Trending This Week</h2>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {apps.map((app, idx) => (
          <div
            key={`trending-${app.id}`}
            onClick={() => onAppClick(app)}
            className="relative flex items-center gap-3 bg-gradient-to-r from-gray-800 to-gray-800/50 border border-gray-700 rounded-xl px-4 py-3 hover:border-orange-500/40 hover:shadow-lg hover:shadow-orange-500/5 transition-all cursor-pointer group"
          >
            {idx < 3 && (
              <span className="absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full bg-orange-500 text-white text-[10px] font-bold flex items-center justify-center shadow">
                {idx + 1}
              </span>
            )}
            <span className="text-2xl group-hover:scale-110 transition-transform">{app.icon}</span>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm text-white font-medium truncate">{app.name}</h3>
              <div className="flex items-center gap-2 mt-0.5">
                {app.avg_rating != null && (
                  <span className="text-[10px] text-yellow-400">★ {app.avg_rating.toFixed(1)}</span>
                )}
                <span className="text-[10px] text-gray-500">{app.launch_count || 0} runs</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/** Top Creators Section */
function TopCreatorsSection({ creators }: { creators: Creator[] }) {
  if (creators.length === 0) return null
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Crown className="w-4 h-4 text-yellow-400" />
        <h2 className="text-sm font-semibold text-white">👑 Top Creators</h2>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {creators.map(creator => (
          <div
            key={creator.id}
            className="flex items-center gap-3 bg-gray-800/60 border border-gray-700 rounded-xl px-4 py-3 flex-shrink-0 min-w-[180px] hover:border-yellow-500/30 transition-colors"
          >
            <div className="relative">
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center text-white text-sm font-bold">
                {creator.avatar ? (
                  <img src={creator.avatar} alt={creator.name} className="w-full h-full rounded-full object-cover" />
                ) : (
                  creator.name.charAt(0).toUpperCase()
                )}
              </div>
              {creator.rank <= 3 && (
                <span className="absolute -bottom-0.5 -right-0.5 text-xs">
                  {creator.rank === 1 ? '🥇' : creator.rank === 2 ? '🥈' : '🥉'}
                </span>
              )}
            </div>
            <div className="min-w-0">
              <h3 className="text-sm text-white font-medium truncate">{creator.name}</h3>
              <p className="text-[10px] text-gray-500">{creator.app_count} apps · {creator.total_runs} runs</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/** App Card — Grid View */
function AppCard({ app, onClick, isFav, onToggleFav, onRun, onFork, onDelete }: {
  app: PublishedApp
  onClick: () => void
  isFav: boolean
  onToggleFav: () => void
  onRun: () => void
  onFork: () => void
  onDelete?: () => void
}) {
  return (
    <div
      onClick={onClick}
      className="bg-gray-800 border border-gray-700 rounded-xl p-4 hover:border-purple-500/50 hover:bg-gray-800/80 transition-all cursor-pointer group relative"
    >
      {/* Top-right actions */}
      <div className="absolute top-3 right-3 flex items-center gap-1">
        {onDelete && (
          <button
            onClick={e => { e.stopPropagation(); onDelete() }}
            className="p-1 rounded-lg hover:bg-red-500/10 transition-colors opacity-0 group-hover:opacity-100"
            title="Delete app"
          >
            <Trash2 className="w-3.5 h-3.5 text-gray-600 hover:text-red-400" />
          </button>
        )}
        <button
          onClick={e => { e.stopPropagation(); onToggleFav() }}
          className="p-1 rounded-lg hover:bg-gray-700 transition-colors"
          title={isFav ? '取消收藏' : '收藏'}
        >
          <Heart className={`w-3.5 h-3.5 ${isFav ? 'text-red-400 fill-red-400' : 'text-gray-600 group-hover:text-gray-400'}`} />
        </button>
      </div>

      {/* Icon + Name */}
      <div className="flex items-start gap-3 mb-3">
        <div className="w-12 h-12 bg-gray-700 rounded-xl flex items-center justify-center text-2xl group-hover:scale-110 transition-transform">
          {app.icon}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-white font-semibold truncate">{app.name}</h3>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-600/20 text-purple-400 capitalize">{app.category}</span>
            <span className="text-[10px] text-gray-600">v{app.version}</span>
          </div>
        </div>
      </div>

      {/* Description */}
      <p className="text-sm text-gray-400 line-clamp-2 mb-3">{app.description || 'No description'}</p>

      {/* Rating + Stats */}
      <div className="flex items-center justify-between mb-3">
        {app.avg_rating ? (
          <StarRating rating={app.avg_rating} count={app.rating_count || 0} />
        ) : (
          <span className="text-[10px] text-gray-600">No ratings yet</span>
        )}
        <div className="flex items-center gap-2">
          {app.launch_count != null && (
            <span className="text-[10px] text-gray-500">{app.launch_count} runs</span>
          )}
          {app.fork_count != null && app.fork_count > 0 && (
            <span className="text-[10px] text-gray-500">{app.fork_count} forks</span>
          )}
        </div>
      </div>

      {/* Author + Action Buttons */}
      <div className="flex items-center justify-between pt-2 border-t border-gray-700/50">
        <div className="flex items-center gap-2">
          {app.author_name && <span className="text-[10px] text-gray-600">by {app.author_name}</span>}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={e => { e.stopPropagation(); onRun() }}
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-purple-600 text-white text-[11px] hover:bg-purple-500 transition-colors"
            title="运行"
          >
            <Play className="w-3 h-3" />
            运行
          </button>
          <button
            onClick={e => { e.stopPropagation(); onFork() }}
            className="p-1.5 rounded-lg text-gray-500 hover:text-blue-400 hover:bg-blue-500/10 transition-colors"
            title="Fork"
          >
            <GitFork className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={e => { e.stopPropagation(); window.open(`/apps/${app.id}`, '_blank') }}
            className="p-1.5 rounded-lg text-gray-500 hover:text-green-400 hover:bg-green-500/10 transition-colors"
            title="新窗口打开"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

/** App Card — List View */
function AppListRow({ app, onClick, isFav, onToggleFav, onRun, onFork, onDelete }: {
  app: PublishedApp
  onClick: () => void
  isFav: boolean
  onToggleFav: () => void
  onRun: () => void
  onFork: () => void
  onDelete?: () => void
}) {
  return (
    <div
      onClick={onClick}
      className="flex items-center gap-4 bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 hover:border-purple-500/50 transition-all cursor-pointer group"
    >
      <button onClick={e => { e.stopPropagation(); onToggleFav() }} className="p-0.5">
        <Heart className={`w-3.5 h-3.5 ${isFav ? 'text-red-400 fill-red-400' : 'text-gray-600 hover:text-gray-400'}`} />
      </button>
      <span className="text-2xl">{app.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="text-white font-medium">{app.name}</h3>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-600/20 text-purple-400 capitalize">{app.category}</span>
        </div>
        <p className="text-sm text-gray-500 truncate">{app.description || 'No description'}</p>
      </div>
      {app.avg_rating ? <StarRating rating={app.avg_rating} count={app.rating_count || 0} /> : null}
      {app.launch_count != null && <span className="text-xs text-gray-600">{app.launch_count} runs</span>}
      <span className="text-xs text-gray-600">v{app.version}</span>
      <div className="flex items-center gap-1">
        <button
          onClick={e => { e.stopPropagation(); onRun() }}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-purple-600 text-white text-xs hover:bg-purple-500 transition-colors"
        >
          <Play className="w-3 h-3" />
          运行
        </button>
        <button
          onClick={e => { e.stopPropagation(); onFork() }}
          className="p-1.5 rounded-lg text-gray-500 hover:text-blue-400 hover:bg-blue-500/10 transition-colors opacity-0 group-hover:opacity-100"
          title="Fork"
        >
          <GitFork className="w-3.5 h-3.5" />
        </button>
        {onDelete && (
          <button
            onClick={e => { e.stopPropagation(); onDelete() }}
            className="p-1.5 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-500/10 transition-colors opacity-0 group-hover:opacity-100"
            title="Delete app"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  )
}

/** Delete Confirmation Dialog */
function DeleteDialog({ app, deleting, onConfirm, onCancel }: {
  app: PublishedApp
  deleting: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => !deleting && onCancel()}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
            <Trash2 className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <h3 className="text-white font-semibold">删除应用</h3>
            <p className="text-xs text-gray-500">此操作不可撤销</p>
          </div>
        </div>
        <p className="text-sm text-gray-400 mb-6">
          确定要永久删除 <span className="text-white">{app.icon} {app.name}</span> 吗？
        </p>
        <div className="flex items-center gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
            disabled={deleting}
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={deleting}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm bg-red-600 text-white hover:bg-red-500 transition-colors disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" />
            {deleting ? '删除中...' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Main Marketplace Component
// ============================================================================

export function Marketplace() {
  const navigate = useNavigate()
  const { favorites, toggle: toggleFav } = useFavorites()
  const { t } = useTranslation()

  // State
  const [apiApps, setApiApps] = useState<PublishedApp[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [sort, setSort] = useState<SortOption>('popular')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [deleteTarget, setDeleteTarget] = useState<PublishedApp | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [challenge, setChallenge] = useState<Challenge | null>(null)
  const [topCreators, setTopCreators] = useState<Creator[]>([])

  // Load apps
  const loadApps = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      if (category !== 'all') params.set('category', category)
      const res = await restClient.get<{ data: PublishedApp[] }>(`/api/apps?${params}`)
      setApiApps(res.data || [])
    } catch (err) {
      console.error('[Marketplace] Failed to load apps:', err)
      setApiApps([])
    } finally {
      setLoading(false)
    }
  }, [search, category])

  // Load challenge (mock for now — will connect to real API)
  const loadChallenge = useCallback(async () => {
    try {
      const res = await restClient.get<{ data: Challenge | null }>('/api/apps/challenge/current')
      setChallenge(res.data)
    } catch {
      // Fallback mock challenge for demo
      setChallenge({
        id: 'weekly-1',
        title: '本周挑战：做一个团队协作工具',
        description: '使用 AI 创建一个帮助团队协作的工具',
        deadline: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        participants: 42,
        reward: '⭐ Featured 展示位',
      })
    }
  }, [])

  // Load top creators (mock for now — will connect to real API)
  const loadCreators = useCallback(async () => {
    try {
      const res = await restClient.get<{ data: Creator[] }>('/api/apps/creators/top')
      setTopCreators(res.data)
    } catch {
      // Derive from apps data
      const creatorMap = new Map<string, Creator>()
      apiApps.forEach(app => {
        if (app.author_name) {
          const existing = creatorMap.get(app.author_name)
          if (existing) {
            existing.app_count++
            existing.total_runs += app.launch_count || 0
          } else {
            creatorMap.set(app.author_name, {
              id: app.author_name,
              name: app.author_name,
              avatar: app.author_avatar,
              app_count: 1,
              total_runs: app.launch_count || 0,
              rank: 0,
            })
          }
        }
      })
      const sorted = [...creatorMap.values()]
        .sort((a, b) => b.total_runs - a.total_runs)
        .slice(0, 6)
        .map((c, i) => ({ ...c, rank: i + 1 }))
      setTopCreators(sorted)
    }
  }, [apiApps])

  useEffect(() => { loadApps() }, [loadApps])
  useEffect(() => { loadChallenge() }, [loadChallenge])
  useEffect(() => { if (apiApps.length > 0) loadCreators() }, [apiApps, loadCreators])

  // Computed data
  const allApps = useMemo(() => {
    let filtered = category === 'all' ? [...apiApps] : apiApps.filter(a => a.category === category)
    if (search) {
      const q = search.toLowerCase()
      filtered = filtered.filter(a =>
        a.name.toLowerCase().includes(q) ||
        (a.description || '').toLowerCase().includes(q) ||
        (a.tags || []).some(tag => tag.includes(q))
      )
    }
    filtered.sort((a, b) => {
      switch (sort) {
        case 'popular': return (b.launch_count || 0) - (a.launch_count || 0)
        case 'newest': return new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
        case 'rating': return (b.avg_rating || 0) - (a.avg_rating || 0)
        case 'name': return a.name.localeCompare(b.name)
        default: return 0
      }
    })
    return filtered
  }, [apiApps, category, search, sort])

  const trending = useMemo(() =>
    [...apiApps].sort((a, b) => (b.launch_count || 0) - (a.launch_count || 0)).slice(0, 4),
    [apiApps]
  )

  const favoriteApps = useMemo(() =>
    apiApps.filter(a => favorites.has(a.id)),
    [apiApps, favorites]
  )

  // Handlers
  const handleAppClick = (app: PublishedApp) => navigate(`/apps/${app.id}`)
  const handleRunApp = (app: PublishedApp) => navigate(`/apps/${app.id}`)
  const handleForkApp = async (app: PublishedApp) => {
    try {
      await restClient.post(`/api/apps/${app.id}/fork`, {})
      loadApps()
    } catch {
      // Fork not supported yet — navigate to detail
      navigate(`/apps/${app.id}`)
    }
  }
  const handleCreateApp = () => navigate('/chat')
  const handleJoinChallenge = (_id: string) => {
    // Navigate to chat with challenge context
    navigate('/chat')
  }

  const handleDeleteApp = useCallback(async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await restClient.delete(`/api/apps/${deleteTarget.id}`)
      setDeleteTarget(null)
      loadApps()
    } catch {
      // stay on dialog
    } finally {
      setDeleting(false)
    }
  }, [deleteTarget, loadApps])

  // Show home sections only when not filtering
  const showHomeSections = !search && category === 'all'

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-800 flex-shrink-0">
        {/* Search + Category Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="🔍 搜索 App 或 Prompt..."
              className="w-full pl-10 pr-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 transition-colors"
            />
          </div>
          <div className="flex items-center gap-1">
            {CATEGORIES.map(cat => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors capitalize ${
                  category === cat ? 'bg-purple-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
                }`}
              >
                {cat === 'all' ? 'All' : cat}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 ml-auto">
            {/* Sort */}
            <div className="flex items-center gap-1">
              <ArrowUpDown className="w-3.5 h-3.5 text-gray-500" />
              {(['popular', 'newest', 'rating', 'name'] as SortOption[]).map(s => (
                <button
                  key={s}
                  onClick={() => setSort(s)}
                  className={`px-2 py-1 rounded text-[11px] font-medium transition-colors capitalize ${
                    sort === s ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-white'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            {/* View toggle */}
            <div className="flex items-center gap-1 border-l border-gray-700 pl-2 ml-1">
              <button
                onClick={() => setView('grid')}
                className={`p-1.5 rounded-lg transition-colors ${view === 'grid' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}
              >
                <Grid3X3 className="w-4 h-4" />
              </button>
              <button
                onClick={() => setView('list')}
                className={`p-1.5 rounded-lg transition-colors ${view === 'list' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}
              >
                <List className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-gray-500 text-sm">{t('marketplace.loading')}</span>
            </div>
          </div>
        ) : (
          <>
            {/* Banner + Challenge */}
            {showHomeSections && (
              <MarketplaceBanner
                challenge={challenge}
                onCreateApp={handleCreateApp}
                onJoinChallenge={handleJoinChallenge}
              />
            )}

            {/* Trending */}
            {showHomeSections && <TrendingSection apps={trending} onAppClick={handleAppClick} />}

            {/* Top Creators */}
            {showHomeSections && <TopCreatorsSection creators={topCreators} />}

            {/* Favorites */}
            {showHomeSections && favoriteApps.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <Heart className="w-4 h-4 text-red-400 fill-red-400" />
                  <h2 className="text-sm font-semibold text-white">❤️ 我的收藏</h2>
                </div>
                <div className="flex gap-3 overflow-x-auto pb-1">
                  {favoriteApps.map(app => (
                    <div
                      key={`fav-${app.id}`}
                      onClick={() => handleAppClick(app)}
                      className="flex items-center gap-3 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 hover:border-red-500/30 transition-all cursor-pointer flex-shrink-0 min-w-[200px]"
                    >
                      <span className="text-xl">{app.icon}</span>
                      <div className="min-w-0">
                        <h3 className="text-sm text-white font-medium truncate">{app.name}</h3>
                        <span className="text-[10px] text-gray-500">v{app.version}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* All Apps */}
            <section>
              {showHomeSections && (
                <div className="flex items-center gap-2 mb-3">
                  <Globe className="w-4 h-4 text-blue-400" />
                  <h2 className="text-sm font-semibold text-white">📱 All Apps</h2>
                  <span className="text-xs text-gray-500 ml-1">{allApps.length} 个应用</span>
                </div>
              )}
              {allApps.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 gap-3">
                  <Search className="w-8 h-8 text-gray-700" />
                  <p className="text-gray-500 text-sm">{t('marketplace.noResults')}</p>
                  {search && (
                    <button
                      onClick={() => { setSearch(''); setCategory('all') }}
                      className="text-xs text-purple-400 hover:text-purple-300"
                    >
                      清除筛选条件
                    </button>
                  )}
                </div>
              ) : view === 'grid' ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {allApps.map(app => (
                    <AppCard
                      key={app.id}
                      app={app}
                      onClick={() => handleAppClick(app)}
                      isFav={favorites.has(app.id)}
                      onToggleFav={() => toggleFav(app.id)}
                      onRun={() => handleRunApp(app)}
                      onFork={() => handleForkApp(app)}
                      onDelete={() => setDeleteTarget(app)}
                    />
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {allApps.map(app => (
                    <AppListRow
                      key={app.id}
                      app={app}
                      onClick={() => handleAppClick(app)}
                      isFav={favorites.has(app.id)}
                      onToggleFav={() => toggleFav(app.id)}
                      onRun={() => handleRunApp(app)}
                      onFork={() => handleForkApp(app)}
                      onDelete={() => setDeleteTarget(app)}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <DeleteDialog
          app={deleteTarget}
          deleting={deleting}
          onConfirm={handleDeleteApp}
          onCancel={() => !deleting && setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
