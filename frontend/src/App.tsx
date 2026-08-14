import { lazy, Suspense, type ComponentType } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { TranslationProvider } from '@/i18n'
import { AppShell } from '@/components/AppShell'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ToastProvider } from '@/components/Toast'
import { ProtectedRoute } from '@/components/ProtectedRoute'
import { AuthProvider } from '@/services/AuthContext'
import { ThemeProvider } from '@/services/ThemeContext'
import { FeatureTogglesProvider } from '@/services/FeatureTogglesContext'
import { useTranslation } from '@/i18n'

function lazyNamed(
  loader: () => Promise<unknown>,
  exportName: string,
) {
  return lazy(async () => {
    const module = await loader() as Record<string, ComponentType>
    const component = module[exportName]
    if (!component) {
      throw new Error(`Missing lazy route export: ${exportName}`)
    }
    return { default: component }
  })
}

const Dashboard = lazyNamed(() => import('@/pages/Dashboard'), 'Dashboard')
const Chat = lazyNamed(() => import('@/pages/Chat'), 'Chat')
const WorkflowEditor = lazyNamed(() => import('@/pages/WorkflowEditor'), 'WorkflowEditor')
const Agents = lazyNamed(() => import('@/pages/Agents'), 'Agents')
const Tools = lazyNamed(() => import('@/pages/Tools'), 'Tools')
const AgentConfigurator = lazyNamed(() => import('@/pages/AgentConfigurator'), 'AgentConfigurator')
const TaskAuditLog = lazyNamed(() => import('@/pages/TaskAuditLog'), 'TaskAuditLog')
const TaskExecutionCenter = lazyNamed(() => import('@/pages/TaskExecutionCenter'), 'TaskExecutionCenter')
const MCPConfigurator = lazyNamed(() => import('@/pages/MCPConfigurator'), 'MCPConfigurator')
const KnowledgeManager = lazyNamed(() => import('@/pages/KnowledgeManager'), 'KnowledgeManager')
const InfrastructureConfigurator = lazyNamed(() => import('@/pages/InfrastructureConfigurator'), 'InfrastructureConfigurator')
const Login = lazyNamed(() => import('@/pages/Login'), 'Login')
const CreateBusinessScope = lazyNamed(() => import('@/pages/CreateBusinessScope'), 'CreateBusinessScope')
const Marketplace = lazyNamed(() => import('@/pages/Marketplace'), 'Marketplace')
const AppRunner = lazyNamed(() => import('@/pages/AppRunner'), 'AppRunner')
const KnowledgeBaseDrive = lazyNamed(() => import('@/pages/KnowledgeBaseDrive'), 'KnowledgeBaseDrive')
const StarredSessions = lazyNamed(() => import('@/pages/StarredSessions'), 'StarredSessions')
const ShowcasePage = lazyNamed(() => import('@/pages/ShowcasePage'), 'ShowcasePage')
const Settings = lazyNamed(() => import('@/pages/Settings'), 'Settings')
const AuthCallback = lazyNamed(() => import('@/pages/AuthCallback'), 'AuthCallback')
const InviteAccept = lazyNamed(() => import('@/pages/InviteAccept'), 'InviteAccept')
const ChatRoomPage = lazyNamed(() => import('@/pages/ChatRoomPage'), 'ChatRoomPage')
const DigitalTwinWizard = lazyNamed(() => import('@/pages/DigitalTwinWizard'), 'DigitalTwinWizard')
const Projects = lazyNamed(() => import('@/pages/Projects'), 'Projects')
const ProjectBoard = lazyNamed(() => import('@/pages/ProjectBoard'), 'ProjectBoard')
const SupportWorkspace = lazyNamed(() => import('@/pages/SupportWorkspace'), 'SupportWorkspace')
const SupportSettings = lazyNamed(() => import('@/pages/SupportSettings'), 'SupportSettings')
const SupportAnalytics = lazyNamed(() => import('@/pages/SupportAnalytics'), 'SupportAnalytics')
const SupportKnowledge = lazyNamed(() => import('@/pages/SupportKnowledge'), 'SupportKnowledge')
const SupportLive = lazyNamed(() => import('@/pages/SupportLive'), 'SupportLive')
const Approvals = lazyNamed(() => import('@/pages/Approvals'), 'Approvals')
const SkillMarketplaceBrowser = lazyNamed(() => import('@/components/SkillMarketplaceBrowser'), 'SkillMarketplaceBrowser')
const AIScopeGenerator = lazyNamed(() => import('@/components/AIScopeGenerator'), 'AIScopeGenerator')
const SkillWorkshop = lazyNamed(() => import('@/components/SkillWorkshop'), 'SkillWorkshop')

function RouteFallback() {
  return (
    <div className="flex h-full min-h-40 items-center justify-center text-sm text-gray-400">
      Loading...
    </div>
  )
}

function AppContent() {
  const { t } = useTranslation()
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* Full-page routes without AppShell */}
        <Route path="/create-business-scope" element={<CreateBusinessScope />} />
        <Route path="/create-business-scope/ai" element={<AIScopeGenerator />} />
        <Route path="/agents/config/:agentId/workshop" element={<SkillWorkshop />} />
        <Route path="/create-digital-twin" element={<DigitalTwinWizard />} />

        {/* Routes with AppShell */}
        <Route path="/*" element={
          <AppShell>
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/chat" element={<Chat />} />
              <Route path="/chat/room/:roomId" element={<ChatRoomPage />} />
              <Route path="/workflow" element={<WorkflowEditor />} />
              <Route path="/approvals" element={<Approvals />} />
              <Route path="/agents" element={<Agents />} />
              <Route path="/agents/config/:agentId" element={<AgentConfigurator />} />
              <Route path="/projects" element={<Projects />} />
              <Route path="/projects/:id" element={<ProjectBoard />} />
              <Route path="/tools" element={<Tools />} />
              <Route path="/tasks" element={<TaskAuditLog />} />
              <Route path="/task-monitoring" element={<TaskExecutionCenter />} />
              {/* Config routes - placeholder for admin menu navigation */}
              <Route path="/config/mcp" element={<MCPConfigurator />} />
              <Route path="/config/skills" element={<SkillMarketplaceBrowser />} />
              <Route path="/config/rest-api" element={<div className="p-6 text-white">{t('config.restApi')}</div>} />
              <Route path="/config/knowledge" element={<KnowledgeManager />} />
              <Route path="/knowledge" element={<KnowledgeBaseDrive />} />
              <Route path="/config/framework" element={<InfrastructureConfigurator />} />
              <Route path="/apps" element={<Marketplace />} />
              <Route path="/apps/:id" element={<AppRunner />} />
              <Route path="/support" element={<SupportWorkspace />} />
              <Route path="/support/live" element={<SupportLive />} />
              <Route path="/support/settings" element={<SupportSettings />} />
              <Route path="/support/analytics" element={<SupportAnalytics />} />
              <Route path="/support/knowledge" element={<SupportKnowledge />} />
              <Route path="/starred" element={<StarredSessions />} />
              <Route path="/showcase" element={<ShowcasePage />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </AppShell>
        } />
      </Routes>
    </Suspense>
  )
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <BrowserRouter>
          <TranslationProvider>
            <ToastProvider>
              <AuthProvider>
                <FeatureTogglesProvider>
                  <Suspense fallback={<RouteFallback />}>
                    <Routes>
                      <Route path="/login" element={<Login />} />
                      <Route path="/auth/callback" element={<AuthCallback />} />
                      <Route path="/invite/:token" element={<InviteAccept />} />
                      <Route path="/*" element={
                        <ProtectedRoute>
                          <AppContent />
                        </ProtectedRoute>
                      } />
                    </Routes>
                  </Suspense>
                </FeatureTogglesProvider>
              </AuthProvider>
            </ToastProvider>
          </TranslationProvider>
        </BrowserRouter>
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default App
