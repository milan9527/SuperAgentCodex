import {
  Star,
  ClipboardCheck,
  FolderKanban,
  Database,
  Rocket,
  Headphones,
  LayoutDashboard,
  MessageSquare,
  GitBranch,
  Users,
  Wrench,
} from 'lucide-react'
import { useFeatureToggles, OPTIONAL_FEATURES, type OptionalFeature } from '@/services/FeatureTogglesContext'
import { useTranslation } from '@/i18n'

const OPTIONAL_META: Record<OptionalFeature, { icon: React.ReactNode; labelKey: string; descKey: string }> = {
  starred: { icon: <Star className="w-5 h-5" />, labelKey: 'nav.starred', descKey: 'features.starredDesc' },
  approvals: { icon: <ClipboardCheck className="w-5 h-5" />, labelKey: 'nav.approvals', descKey: 'features.approvalsDesc' },
  projects: { icon: <FolderKanban className="w-5 h-5" />, labelKey: 'nav.projects', descKey: 'features.projectsDesc' },
  knowledge: { icon: <Database className="w-5 h-5" />, labelKey: 'nav.knowledge', descKey: 'features.knowledgeDesc' },
  apps: { icon: <Rocket className="w-5 h-5" />, labelKey: 'nav.apps', descKey: 'features.appsDesc' },
  support: { icon: <Headphones className="w-5 h-5" />, labelKey: 'nav.support', descKey: 'features.supportDesc' },
}

const CORE_META: { icon: React.ReactNode; labelKey: string }[] = [
  { icon: <LayoutDashboard className="w-5 h-5" />, labelKey: 'nav.dashboard' },
  { icon: <MessageSquare className="w-5 h-5" />, labelKey: 'nav.chat' },
  { icon: <GitBranch className="w-5 h-5" />, labelKey: 'nav.workflow' },
  { icon: <Users className="w-5 h-5" />, labelKey: 'nav.agents' },
  { icon: <Wrench className="w-5 h-5" />, labelKey: 'nav.tools' },
]

export function FeaturesTab() {
  const { features, setFeature } = useFeatureToggles()
  const { t } = useTranslation()

  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-semibold text-white mb-1">{t('features.title')}</h2>
      <p className="text-sm text-gray-400 mb-6">{t('features.subtitle')}</p>

      {/* Core features — always on, shown for context */}
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
        {t('features.coreTitle')}
      </h3>
      <div className="flex flex-wrap gap-2 mb-8">
        {CORE_META.map((c) => (
          <span
            key={c.labelKey}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800/60 border border-gray-700 text-sm text-gray-300"
          >
            <span className="text-gray-400">{c.icon}</span>
            {t(c.labelKey)}
          </span>
        ))}
      </div>

      {/* Optional features — user toggles */}
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
        {t('features.optionalTitle')}
      </h3>
      <div className="space-y-2">
        {OPTIONAL_FEATURES.map((id) => {
          const meta = OPTIONAL_META[id]
          const enabled = features[id]
          return (
            <div
              key={id}
              className="flex items-center justify-between p-4 rounded-xl border border-gray-700 bg-gray-800/50"
            >
              <div className="flex items-center gap-3">
                <span className={enabled ? 'text-blue-400' : 'text-gray-400'}>{meta.icon}</span>
                <div>
                  <div className="text-sm font-medium text-gray-200">{t(meta.labelKey)}</div>
                  <div className="text-xs text-gray-500">{t(meta.descKey)}</div>
                </div>
              </div>
              <button
                role="switch"
                aria-checked={enabled}
                aria-label={t(meta.labelKey)}
                onClick={() => setFeature(id, !enabled)}
                className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${
                  enabled ? 'bg-blue-600' : 'bg-gray-600'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                    enabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
