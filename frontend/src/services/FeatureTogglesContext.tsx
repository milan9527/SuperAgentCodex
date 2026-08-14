import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { NavigationPage } from '@/types'
import { useAuth } from '@/services/AuthContext'
import { restClient } from '@/services/api/restClient'

/**
 * Optional (user-toggleable) navigation features. The core pages
 * (dashboard, chat, workflow, agents, tools) are always visible and are
 * intentionally NOT part of this set.
 */
export type OptionalFeature = 'starred' | 'approvals' | 'projects' | 'knowledge' | 'apps' | 'support'

export const OPTIONAL_FEATURES: OptionalFeature[] = [
  'starred',
  'approvals',
  'projects',
  'knowledge',
  'apps',
  'support',
]

/** Navigation pages that can never be turned off. */
export const CORE_FEATURES: NavigationPage[] = ['dashboard', 'chat', 'workflow', 'agents', 'tools']

type FeatureState = Record<OptionalFeature, boolean>

/** Optional features default to OFF — a fresh sidebar shows only the core pages. */
const DEFAULT_STATE: FeatureState = {
  starred: false,
  approvals: false,
  projects: false,
  knowledge: false,
  apps: false,
  support: false,
}

/**
 * localStorage is used only as an instant-paint cache so the sidebar doesn't
 * flicker on reload while the authoritative value loads from the backend.
 */
const CACHE_KEY = 'featureToggles'
/** Key under the profile's `preferences` JSON object. */
const PREF_KEY = 'featureToggles'

interface FeatureTogglesContextType {
  features: FeatureState
  isEnabled: (feature: OptionalFeature) => boolean
  setFeature: (feature: OptionalFeature, enabled: boolean) => void
}

const FeatureTogglesContext = createContext<FeatureTogglesContextType | undefined>(undefined)

function normalize(raw: unknown): FeatureState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_STATE }
  const obj = raw as Partial<FeatureState>
  // Merge over defaults so only known keys are kept and new ones get a default.
  const out = { ...DEFAULT_STATE }
  for (const key of OPTIONAL_FEATURES) {
    if (typeof obj[key] === 'boolean') out[key] = obj[key] as boolean
  }
  return out
}

function loadCache(): FeatureState {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? normalize(JSON.parse(raw)) : { ...DEFAULT_STATE }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

export function FeatureTogglesProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth()
  const [features, setFeatures] = useState<FeatureState>(loadCache)
  // Guards against persisting the backend-loaded value straight back to the backend.
  const loadedFromServer = useRef(false)

  // Load authoritative preferences from the backend once authenticated.
  useEffect(() => {
    if (!isAuthenticated) {
      loadedFromServer.current = false
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await restClient.get<{ preferences?: Record<string, unknown> }>(
          '/api/user/preferences',
        )
        if (cancelled) return
        const next = normalize(res.preferences?.[PREF_KEY])
        loadedFromServer.current = true
        setFeatures(next)
        localStorage.setItem(CACHE_KEY, JSON.stringify(next))
      } catch {
        // Keep the cached value if the request fails; user can still toggle.
        loadedFromServer.current = true
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isAuthenticated])

  const persist = (next: FeatureState) => {
    localStorage.setItem(CACHE_KEY, JSON.stringify(next))
    if (isAuthenticated) {
      // Fire-and-forget; the optimistic UI update already happened.
      void restClient
        .put('/api/user/preferences', { [PREF_KEY]: next })
        .catch(() => {
          /* best-effort; cache still holds the value */
        })
    }
  }

  const isEnabled = (feature: OptionalFeature) => features[feature]

  const setFeature = (feature: OptionalFeature, enabled: boolean) => {
    setFeatures((prev) => {
      const next = { ...prev, [feature]: enabled }
      persist(next)
      return next
    })
  }

  return (
    <FeatureTogglesContext.Provider value={{ features, isEnabled, setFeature }}>
      {children}
    </FeatureTogglesContext.Provider>
  )
}

export function useFeatureToggles() {
  const ctx = useContext(FeatureTogglesContext)
  if (!ctx) throw new Error('useFeatureToggles must be used within FeatureTogglesProvider')
  return ctx
}
