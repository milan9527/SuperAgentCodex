import { Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { LayoutGrid, MessageSquare, FileText, Plug, Sun, Moon, Monitor } from 'lucide-react'
import { useTheme, type Theme } from './services/ThemeContext'
import SolutionMarketplace from './pages/SolutionMarketplace'
import OnboardingWizard from './pages/OnboardingWizard'
import ScopeBlueprint from './pages/ScopeBlueprint'
import ConnectorMarketplace from './pages/ConnectorMarketplace'

const navItems = [
  { path: '/solution-marketplace', label: '解决方案市场', icon: LayoutGrid },
  { path: '/onboarding-wizard', label: '引导式配置', icon: MessageSquare },
  { path: '/scope-blueprint', label: '业务域蓝图', icon: FileText },
  { path: '/connector-marketplace', label: '连接器市场', icon: Plug },
]

const themeOptions: { id: Theme; icon: typeof Sun }[] = [
  { id: 'light', icon: Sun },
  { id: 'dark', icon: Moon },
  { id: 'system', icon: Monitor },
]

export default function App() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="min-h-screen bg-gray-900">
      {/* Top Navigation */}
      <header className="sticky top-0 z-50 bg-gray-900/80 backdrop-blur-md border-b border-gray-700">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
              <span className="text-white font-bold text-sm">SA</span>
            </div>
            <span className="font-semibold text-white">Super Agent</span>
            <span className="text-xs ml-2 px-2 py-0.5 bg-blue-500/20 text-blue-400 rounded-full font-medium">
              BizOps 易用性设计
            </span>
          </div>

          <div className="flex items-center gap-4">
            {/* Navigation */}
            <nav className="flex items-center gap-1">
              {navItems.map(item => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={({ isActive }) =>
                    `flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors duration-150 ${
                      isActive
                        ? 'bg-blue-500/20 text-blue-400'
                        : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                    }`
                  }
                >
                  <item.icon size={16} />
                  <span className="hidden lg:inline">{item.label}</span>
                </NavLink>
              ))}
            </nav>

            {/* Theme Toggle */}
            <div className="flex items-center gap-0.5 p-1 rounded-lg bg-gray-800 border border-gray-700">
              {themeOptions.map(opt => (
                <button
                  key={opt.id}
                  onClick={() => setTheme(opt.id)}
                  className={`p-1.5 rounded-md transition-colors ${
                    theme === opt.id
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-400 hover:text-gray-200'
                  }`}
                  title={opt.id === 'light' ? '浅色' : opt.id === 'dark' ? '深色' : '跟随系统'}
                >
                  <opt.icon size={14} />
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Navigate to="/solution-marketplace" replace />} />
          <Route path="/solution-marketplace" element={<SolutionMarketplace />} />
          <Route path="/onboarding-wizard" element={<OnboardingWizard />} />
          <Route path="/scope-blueprint" element={<ScopeBlueprint />} />
          <Route path="/connector-marketplace" element={<ConnectorMarketplace />} />
        </Routes>
      </main>
    </div>
  )
}
