/**
 * ProjectBoard Page
 * Kanban board + list view with agent execution and auto-process.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Plus, LayoutGrid, List, Loader2, GripVertical, Bot, User, MessageSquare, Settings, Play, X, Sparkles, Terminal, ChevronDown, ChevronUp, Send, RefreshCw, FileCode, Crown, Trash2, Tag, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { RestProjectService, type Project, type ProjectIssue, type IssueComment, type IssueRelation, type TriageReport, type ProjectAgent, type TriageAction, type ActionResult } from '@/services/api/restProjectService'
import { RestBusinessScopeService } from '@/services/api/restBusinessScopeService'
import { RestAgentService } from '@/services/api/restAgentService'
import { restClient } from '@/services/api/restClient'
import { useTranslation } from '@/i18n'
import { WorkspaceExplorer } from '@/components/WorkspaceExplorer'
import { ArtifactListPanel } from '@/components/chat/ArtifactListPanel'
import { WorkspaceActions } from '@/components/WorkspaceActions'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const LANES = [
  { id: 'backlog', labelKey: 'project.backlog', color: 'border-gray-600' },
  { id: 'todo', labelKey: 'project.todo', color: 'border-blue-600' },
  { id: 'in_progress', labelKey: 'project.inProgress', color: 'border-yellow-600' },
  { id: 'in_review', labelKey: 'project.inReview', color: 'border-purple-600' },
  { id: 'done', labelKey: 'project.done', color: 'border-green-600' },
]

const PRIORITY_BADGES: Record<string, { label: string; cls: string }> = {
  critical: { label: '🔴', cls: 'text-red-400' },
  high: { label: '🟠', cls: 'text-orange-400' },
  medium: { label: '🟡', cls: 'text-yellow-400' },
  low: { label: '🟢', cls: 'text-green-400' },
}

const RELATION_TYPE_CONFIG: Record<string, { icon: string; labelKey: string }> = {
  conflicts_with: { icon: '⚠️', labelKey: 'project.conflictsWith' },
  depends_on: { icon: '🔗', labelKey: 'project.dependsOn' },
  duplicates: { icon: '📋', labelKey: 'project.duplicatesOf' },
  related_to: { icon: '🔄', labelKey: 'project.relatedTo' },
}

type ViewMode = 'board' | 'list'

export function ProjectBoard() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [project, setProject] = useState<Project | null>(null)
  const [issues, setIssues] = useState<ProjectIssue[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>('board')
  const [dragIssueId, setDragIssueId] = useState<string | null>(null)

  // Dialogs
  const [showCreateIssue, setShowCreateIssue] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showExecuteConfirm, setShowExecuteConfirm] = useState<ProjectIssue | null>(null)
  const [selectedIssue, setSelectedIssue] = useState<ProjectIssue | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editPriority, setEditPriority] = useState('medium')
  const [editStatus, setEditStatus] = useState('backlog')
  const [isSavingIssue, setIsSavingIssue] = useState(false)

  // AI Refine diff
  const [isRefining, setIsRefining] = useState(false)
  const [refinedDesc, setRefinedDesc] = useState<string | null>(null) // non-null = show diff

  // Code diff viewer
  const [showDiffPanel, setShowDiffPanel] = useState(false)
  const [diffPatch, setDiffPatch] = useState<string | null>(null)
  const [diffStat, setDiffStat] = useState<import('@/services/api/restProjectService').DiffStat | null>(null)
  const [loadingDiff, setLoadingDiff] = useState(false)

  // Issue detail comments
  const [issueComments, setIssueComments] = useState<IssueComment[]>([])
  const [loadingComments, setLoadingComments] = useState(false)
  const [newComment, setNewComment] = useState('')
  const [postingComment, setPostingComment] = useState(false)
  const commentsEndRef = useRef<HTMLDivElement>(null)

  // Create issue form
  const [newIssueTitle, setNewIssueTitle] = useState('')
  const [newIssueLane, setNewIssueLane] = useState('backlog')
  const [newIssuePriority, setNewIssuePriority] = useState('medium')

  // Settings
  const [autoProcess, setAutoProcess] = useState(false)
  const autoProcessRef = useRef(false)
  const autoProcessTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // AI Governance
  const [projectRelations, setProjectRelations] = useState<IssueRelation[]>([])
  const [issueRelations, setIssueRelations] = useState<IssueRelation[]>([])
  const [showTriageReport, setShowTriageReport] = useState(false)
  const [triageReport, setTriageReport] = useState<TriageReport | null>(null)
  const [isGeneratingTriage, setIsGeneratingTriage] = useState(false)

  // Workspace panel
  const [wsPanelWidth, setWsPanelWidth] = useState(288)
  const [wsRefreshKey, setWsRefreshKey] = useState(0)

  // Agent console (bottom panel)
  const [showConsole, setShowConsole] = useState(false)
  const [consoleHeight, setConsoleHeight] = useState(200)
  const [consoleMessages, setConsoleMessages] = useState<Array<{ id: string; type: string; content: string; created_at: string }>>([])
  const consoleEndRef = useRef<HTMLDivElement>(null)

  // Tab system (like Chat module): Board is default, file tabs can be opened
  interface FileTab { id: string; name: string; path: string }
  const [fileTabs, setFileTabs] = useState<FileTab[]>([])
  const [activeTab, setActiveTab] = useState<string>('board') // 'board' | 'file:{path}'
  const [fileContents, setFileContents] = useState<Record<string, { content: string | null; loading: boolean }>>({})

  // Right panel mode
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false)
  const [rightPanelTab, setRightPanelTab] = useState<'workspace' | 'artifacts'>('workspace')

  const handleFileOpen = useCallback(async (path: string, name: string) => {
    const tabId = `file:${path}`
    setFileTabs(prev => {
      if (prev.find(t => t.id === tabId)) return prev
      return [...prev, { id: tabId, name, path }]
    })
    setActiveTab(tabId)

    // Load file content if not cached
    setFileContents(prev => {
      if (prev[tabId]?.content !== undefined) return prev
      return { ...prev, [tabId]: { content: null, loading: true } }
    })

    try {
      const sid = project?.workspace_session_id
      if (!sid) return
      const res = await restClient.get<{ content: string }>(`/api/chat/sessions/${sid}/workspace/file?path=${encodeURIComponent(path)}`)
      setFileContents(prev => ({ ...prev, [tabId]: { content: res.content ?? '', loading: false } }))
    } catch (err) {
      setFileContents(prev => ({ ...prev, [tabId]: { content: `// Failed to load: ${err instanceof Error ? err.message : 'Error'}`, loading: false } }))
    }
  }, [project?.workspace_session_id])

  const handleCloseFileTab = useCallback((tabId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setFileTabs(prev => prev.filter(t => t.id !== tabId))
    if (activeTab === tabId) setActiveTab('board')
    setFileContents(prev => { const next = { ...prev }; delete next[tabId]; return next })
  }, [activeTab])

  const loadData = useCallback(async () => {
    if (!projectId) return
    try {
      const [proj, issueList] = await Promise.all([
        RestProjectService.getProject(projectId),
        RestProjectService.listIssues(projectId),
      ])
      setProject(proj)
      setIssues(issueList)

      // Ensure workspace session exists (lazy init)
      if (!proj.workspace_session_id) {
        try {
          const sessionId = await RestProjectService.ensureWorkspace(projectId)
          setProject(prev => prev ? { ...prev, workspace_session_id: sessionId } : prev)
        } catch { /* workspace init can fail silently */ }
      }

      // Load settings
      try {
        const settings = await RestProjectService.getSettings(projectId)
        const ap = !!settings.auto_process
        setAutoProcess(ap)
        autoProcessRef.current = ap
      } catch { /* no settings yet */ }

      // Load project-level relations for card badges
      try {
        const rels = await RestProjectService.getProjectRelations(projectId)
        setProjectRelations(rels)
      } catch { /* relations not critical */ }
    } catch (err) {
      console.error('Failed to load project:', err)
    } finally {
      setIsLoading(false)
    }
  }, [projectId])

  useEffect(() => { loadData() }, [loadData])

  // Listen for preview-ready events from WorkspaceActions to open preview in new browser tab
  useEffect(() => {
    const onPreviewReady = (e: Event) => {
      const { url } = (e as CustomEvent).detail
      if (url) {
        const token = localStorage.getItem('local_auth_token') || localStorage.getItem('cognito_id_token')
        const fullUrl = token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url
        window.open(fullUrl, '_blank')
      }
    }
    window.addEventListener('preview-ready', onPreviewReady)
    return () => window.removeEventListener('preview-ready', onPreviewReady)
  }, [])

  // Poll agent console messages when panel is open
  useEffect(() => {
    const sessionId = project?.workspace_session_id
    if (!showConsole || !sessionId) return

    const loadMessages = async () => {
      try {
        const messages = await restClient.get<Array<{ id: string; type: string; content: string; created_at: string }>>(
          `/api/chat/history/${sessionId}?limit=50`
        )
        setConsoleMessages(Array.isArray(messages) ? messages : [])
        setTimeout(() => consoleEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
      } catch { /* ignore */ }
    }

    loadMessages()
    const interval = setInterval(loadMessages, 3000)
    return () => clearInterval(interval)
  }, [showConsole, project?.workspace_session_id])

  // Auto-process polling: when enabled, check every 10s if there's a todo to pick up
  // Also refresh the board periodically to pick up status changes from backend auto-processor
  useEffect(() => {
    if (autoProcessTimerRef.current) {
      clearInterval(autoProcessTimerRef.current)
      autoProcessTimerRef.current = null
    }
    if (autoProcess && projectId) {
      autoProcessTimerRef.current = setInterval(async () => {
        if (!autoProcessRef.current || !projectId) return
        try {
          // Refresh board to pick up any status changes from backend auto-processor
          loadData()
          const result = await RestProjectService.autoProcessNext(projectId)
          if (result.status === 'started') {
            if (result.session_id) {
              setProject(prev => prev ? { ...prev, workspace_session_id: result.session_id! } : prev)
            }
            setWsRefreshKey(k => k + 1)
            loadData() // refresh board again after starting
          }
        } catch (err) {
          console.error('Auto-process error:', err)
        }
      }, 10000)
    }
    return () => {
      if (autoProcessTimerRef.current) clearInterval(autoProcessTimerRef.current)
    }
  }, [autoProcess, projectId, loadData])

  const handleCreateIssue = async () => {
    if (!projectId || !newIssueTitle.trim()) return
    await RestProjectService.createIssue(projectId, {
      title: newIssueTitle.trim(),
      status: newIssueLane,
      priority: newIssuePriority,
    })
    setNewIssueTitle('')
    setShowCreateIssue(false)
    loadData()
    // AI enrichment runs async (~3-5s). Refresh again to pick up analysis results.
    setTimeout(() => loadData(), 5000)
    setTimeout(() => loadData(), 10000)
  }

  const handleDrop = async (issueId: string, newStatus: string) => {
    if (!projectId) return
    const issue = issues.find(i => i.id === issueId)
    if (!issue) return

    // If dropping into in_progress, show confirmation dialog
    if (newStatus === 'in_progress' && issue.status !== 'in_progress') {
      setShowExecuteConfirm(issue)
      setDragIssueId(null)
      return
    }

    // Otherwise just change status
    setIssues(prev => prev.map(i => i.id === issueId ? { ...i, status: newStatus } : i))
    await RestProjectService.changeStatus(projectId, issueId, newStatus)
    setDragIssueId(null)
  }

  const handleExecuteConfirm = async () => {
    if (!projectId || !showExecuteConfirm) return
    try {
      const result = await RestProjectService.executeIssue(projectId, showExecuteConfirm.id)
      // Update the project's workspace_session_id so the panel shows files
      setProject(prev => prev ? { ...prev, workspace_session_id: result.session_id } : prev)
      setShowExecuteConfirm(null)
      setWsRefreshKey(k => k + 1)
      setShowConsole(true) // auto-open console to show agent activity
      loadData()
    } catch (err) {
      console.error('Execute failed:', err)
      alert(`Agent execution failed: ${err instanceof Error ? err.message : 'Unknown error'}. Make sure the project has a Business Scope configured.`)
    }
  }

  const handleSkipExecute = async () => {
    if (!projectId || !showExecuteConfirm) return
    // Just move to in_progress without agent
    await RestProjectService.changeStatus(projectId, showExecuteConfirm.id, 'in_progress')
    setShowExecuteConfirm(null)
    loadData()
  }

  const handleToggleAutoProcess = async (enabled: boolean) => {
    if (!projectId) return
    setAutoProcess(enabled)
    autoProcessRef.current = enabled
    await RestProjectService.updateSettings(projectId, { auto_process: enabled })
    // If just enabled, immediately try to pick up a todo task
    if (enabled) {
      try {
        const result = await RestProjectService.autoProcessNext(projectId)
        if (result.status === 'started') {
          if (result.session_id) {
            setProject(prev => prev ? { ...prev, workspace_session_id: result.session_id! } : prev)
          }
          setWsRefreshKey(k => k + 1)
          loadData()
        }
      } catch (err) {
        console.error('Initial auto-process failed:', err)
      }
    }
  }

  const handleOpenIssue = (issue: ProjectIssue) => {
    setSelectedIssue(issue)
    setEditTitle(issue.title)
    setEditDesc(issue.description ?? '')
    setEditPriority(issue.priority)
    setEditStatus(issue.status)
    setIssueComments([])
    setNewComment('')
    setRefinedDesc(null)
    setIsRefining(false)
    setShowDiffPanel(false)
    setDiffPatch(null)
    setDiffStat(null)
    // Load comments
    if (projectId) {
      setLoadingComments(true)
      RestProjectService.listComments(projectId, issue.id)
        .then(comments => {
          setIssueComments(comments)
          setTimeout(() => commentsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
        })
        .catch(() => {})
        .finally(() => setLoadingComments(false))
    }
  }

  const handlePostComment = async () => {
    if (!projectId || !selectedIssue || !newComment.trim()) return
    setPostingComment(true)
    try {
      const comment = await RestProjectService.addComment(projectId, selectedIssue.id, newComment.trim())
      setIssueComments(prev => [...prev, comment])
      setNewComment('')
      setTimeout(() => commentsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
      loadData() // refresh comment counts on cards
    } catch (err) {
      console.error('Failed to post comment:', err)
    } finally {
      setPostingComment(false)
    }
  }

  const handleSaveIssue = async () => {
    if (!projectId || !selectedIssue) return
    setIsSavingIssue(true)
    try {
      await RestProjectService.updateIssue(projectId, selectedIssue.id, {
        title: editTitle.trim(),
        description: editDesc.trim() || undefined,
        priority: editPriority,
      })
      if (editStatus !== selectedIssue.status) {
        await RestProjectService.changeStatus(projectId, selectedIssue.id, editStatus)
      }
      setSelectedIssue(null)
      loadData()
    } finally {
      setIsSavingIssue(false)
    }
  }

  const handleDeleteSelectedIssue = async () => {
    if (!projectId || !selectedIssue || !confirm(t('project.deleteIssueConfirm'))) return
    await RestProjectService.deleteIssue(projectId, selectedIssue.id)
    setSelectedIssue(null)
    loadData()
  }

  const _handleDeleteIssue = async (issueId: string) => {
    if (!projectId || !confirm(t('project.deleteIssueConfirm'))) return
    await RestProjectService.deleteIssue(projectId, issueId)
    loadData()
  }

  // --- AI Governance handlers ---

  const handleGenerateTriage = async () => {
    if (!projectId) return
    setIsGeneratingTriage(true)
    try {
      const report = await RestProjectService.generateTriage(projectId)
      setTriageReport(report)
      setShowTriageReport(true)
    } catch (err) {
      console.error('Triage generation failed:', err)
      alert(`Triage failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setIsGeneratingTriage(false)
    }
  }

  const handleReviewRelation = async (relationId: string, action: 'confirmed' | 'dismissed') => {
    if (!projectId) return
    try {
      await RestProjectService.reviewRelation(projectId, relationId, action)
      // Refresh relations for the selected issue
      if (selectedIssue) {
        const rels = await RestProjectService.getIssueRelations(projectId, selectedIssue.id)
        setIssueRelations(rels)
      }
      // Refresh project-level relations
      const projRels = await RestProjectService.getProjectRelations(projectId)
      setProjectRelations(projRels)
      // Refresh issues to get updated readiness scores
      loadData()
    } catch (err) {
      console.error('Review relation failed:', err)
    }
  }

  const handleReanalyze = async () => {
    if (!projectId || !selectedIssue) return
    try {
      await RestProjectService.reanalyzeIssue(projectId, selectedIssue.id)
      // Update local state to show analyzing status
      setIssues(prev => prev.map(i => i.id === selectedIssue.id ? { ...i, ai_analysis_status: 'analyzing' } : i))
      setSelectedIssue(prev => prev ? { ...prev, ai_analysis_status: 'analyzing' } : prev)
    } catch (err) {
      console.error('Re-analyze failed:', err)
    }
  }

  // Load issue relations when opening issue detail
  const handleOpenIssueWithRelations = (issue: ProjectIssue) => {
    handleOpenIssue(issue)
    // Load relations for this issue
    if (projectId) {
      RestProjectService.getIssueRelations(projectId, issue.id)
        .then(setIssueRelations)
        .catch(() => setIssueRelations([]))
    }
  }

  // Helper: get relations for a specific issue from project-level cache
  const getIssueRelationsFromCache = (issueId: string) => {
    return projectRelations.filter(r => r.source_issue_id === issueId || r.target_issue_id === issueId)
  }

  const renderRightPanel = () => {
    if (rightPanelCollapsed) {
      return (
        <button
          onClick={() => setRightPanelCollapsed(false)}
          className="border-l border-gray-800 px-1.5 pt-2 text-gray-500 hover:text-white hover:bg-gray-800 transition-colors flex-shrink-0 h-full"
          title="展开面板"
        >
          <PanelRightOpen className="w-4 h-4" />
        </button>
      )
    }
    return (
      <div className="border-l border-gray-800 bg-gray-900 flex flex-col flex-shrink-0" style={{ width: wsPanelWidth }}>
        <div className="flex border-b border-gray-800 flex-shrink-0">
          <button
            onClick={() => setRightPanelTab('artifacts')}
            className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
              rightPanelTab === 'artifacts' ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-800/50' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            📋 产出物
          </button>
          <button
            onClick={() => setRightPanelTab('workspace')}
            className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
              rightPanelTab === 'workspace' ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-800/50' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            📁 文件管理
          </button>
          <button
            onClick={() => setRightPanelCollapsed(true)}
            className="px-2 py-2 text-gray-500 hover:text-white hover:bg-gray-800 transition-colors"
            title="收起面板"
          >
            <PanelRightClose className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          {rightPanelTab === 'artifacts' ? (
            <ArtifactListPanel
              sessionId={project?.workspace_session_id ?? null}
              isGenerating={false}
              onFileOpen={handleFileOpen}
              onPreviewApp={async (folder) => {
                if (!project?.workspace_session_id) return
                try {
                  const res = await restClient.post<{ id: string; name: string; access_url: string }>('/api/apps/publish-from-workspace', {
                    session_id: project.workspace_session_id,
                    folder_path: folder,
                    name: 'preview',
                    status: 'preview',
                  })
                  window.dispatchEvent(new CustomEvent('preview-ready', {
                    detail: { url: res.access_url, name: res.name, appId: res.id },
                  }))
                } catch (err) {
                  console.error('[ProjectBoard] Preview failed:', err)
                }
              }}
              onPublishApp={async (folder) => {
                if (!project?.workspace_session_id) return
                try {
                  await restClient.post<{ id: string; name: string; access_url: string }>('/api/apps/publish-from-workspace', {
                    session_id: project.workspace_session_id,
                    folder_path: folder,
                    name: project.name || 'app',
                    status: 'published',
                  })
                } catch (err) {
                  console.error('[ProjectBoard] Publish failed:', err)
                }
              }}
              refreshKey={wsRefreshKey}
            />
          ) : (
            <WorkspaceExplorer
              sessionId={project?.workspace_session_id ?? null}
              businessScopeId={project?.business_scope_id}
              refreshKey={wsRefreshKey}
              width={wsPanelWidth}
              onWidthChange={setWsPanelWidth}
              onFileOpen={handleFileOpen}
            />
          )}
        </div>
      </div>
    )
  }

  if (isLoading) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="w-8 h-8 text-blue-500 animate-spin" /></div>
  }
  if (!project) {
    return <div className="flex items-center justify-center h-full text-gray-400">{t('project.notFound')}</div>
  }

  return (
    <div className="flex flex-col h-full bg-gray-950">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/projects')} className="p-1.5 hover:bg-gray-800 rounded-lg transition-colors">
            <ArrowLeft size={18} className="text-gray-400" />
          </button>
          <div>
            <h1 className="text-sm font-semibold text-white">{project.name}</h1>
            {project.description && <p className="text-xs text-gray-500">{project.description}</p>}
          </div>
          {autoProcess && (
            <span className="flex items-center gap-1 px-2 py-0.5 bg-green-600/20 text-green-400 text-[10px] rounded-full border border-green-500/30">
              <Play size={8} /> Auto
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex bg-gray-800 rounded-lg p-0.5">
            <button onClick={() => setViewMode('board')} className={`px-2.5 py-1 text-xs rounded-md transition-colors ${viewMode === 'board' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
              <LayoutGrid size={14} />
            </button>
            <button onClick={() => setViewMode('list')} className={`px-2.5 py-1 text-xs rounded-md transition-colors ${viewMode === 'list' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
              <List size={14} />
            </button>
          </div>
          <button onClick={() => setShowCreateIssue(true)} className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg transition-colors">
            <Plus size={14} /> {t('project.newIssue')}
          </button>
          <button
            onClick={handleGenerateTriage}
            disabled={isGeneratingTriage}
            className="flex items-center gap-1 px-3 py-1.5 bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 text-xs rounded-lg border border-purple-500/20 transition-colors disabled:opacity-50"
            title={t('project.aiTriageHint')}
          >
            {isGeneratingTriage ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {t('project.aiTriage')}
          </button>
          <button onClick={() => setShowSettings(true)} className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors" title={t('project.settings')}>
            <Settings size={18} />
          </button>
          <button
            onClick={async () => {
              if (!projectId) return
              try {
                const result = await RestProjectService.syncWorkspace(projectId)
                setWsRefreshKey(k => k + 1)
                console.log(`Synced ${result.synced} files`)
              } catch (err) {
                console.error('Sync failed:', err)
              }
            }}
            className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
            title={t('project.syncWorkspace')}
          >
            <RefreshCw size={18} />
          </button>
          <button
            onClick={() => setShowConsole(!showConsole)}
            className={`p-1.5 rounded-lg transition-colors ${showConsole ? 'text-green-400 bg-green-600/20' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
            title={t('project.agentConsole')}
          >
            <Terminal size={18} />
          </button>
        </div>
      </div>

      {/* Main area: Left (tabs + content) | Right (panel) */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left side: Tab bar + Content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Tab Bar — only visible when file tabs are open */}
          {fileTabs.length > 0 && (
            <div className="flex items-center gap-0.5 px-4 py-1 border-b border-gray-800 bg-gray-900/80 overflow-x-auto flex-shrink-0">
              <button
                onClick={() => setActiveTab('board')}
                className={`px-3 py-1.5 text-xs rounded-t-md transition-colors flex-shrink-0 ${
                  activeTab === 'board'
                    ? 'bg-gray-800 text-white border-b-2 border-blue-500'
                    : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
                }`}
              >
                📋 Board
              </button>
              {fileTabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-t-md transition-colors flex-shrink-0 group ${
                    activeTab === tab.id
                      ? 'bg-gray-800 text-white border-b-2 border-blue-500'
                      : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
                  }`}
                >
                  <span className="truncate max-w-[120px]">{tab.name}</span>
                  <span
                    onClick={(e) => handleCloseFileTab(tab.id, e)}
                    className="ml-1 p-0.5 rounded hover:bg-gray-600 text-gray-500 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X size={10} />
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Content area */}
          {activeTab === 'board' ? (
            <>
              {viewMode === 'board' ? (
                <div className="flex-1 flex overflow-x-auto p-4 gap-3">
          {LANES.map(lane => {
            const laneIssues = issues.filter(i => i.status === lane.id).sort((a, b) => a.sort_order - b.sort_order)
            return (
              <div
                key={lane.id}
                className={`flex-1 min-w-[180px] flex flex-col bg-gray-900/50 rounded-xl border-t-2 ${lane.color}`}
                onDragOver={e => e.preventDefault()}
                onDrop={() => dragIssueId && handleDrop(dragIssueId, lane.id)}
              >
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-xs font-medium text-gray-300">{t(lane.labelKey)}</span>
                  <span className="text-xs text-gray-500">{laneIssues.length}</span>
                </div>
                <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-2">
                  {laneIssues.map(issue => (
                    <IssueCard key={issue.id} issue={issue} relations={getIssueRelationsFromCache(issue.id)} onDragStart={() => setDragIssueId(issue.id)} onClick={() => handleOpenIssueWithRelations(issue)} />
                  ))}
                </div>
              </div>
            )
          })}
                </div>
              ) : (
                <div className="flex-1 overflow-auto p-4">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                        <th className="pb-2">#</th><th className="pb-2">{t('project.colTitle')}</th><th className="pb-2">{t('project.colStatus')}</th><th className="pb-2">{t('project.colPriority')}</th><th className="pb-2">{t('project.colCreator')}</th><th className="pb-2">{t('project.colCreated')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {issues.map(issue => (
                        <tr key={issue.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors cursor-pointer" onClick={() => handleOpenIssueWithRelations(issue)}>
                          <td className="py-2 pl-3 text-gray-500">{issue.issue_number}</td>
                          <td className="py-2 text-white">{issue.title}</td>
                          <td className="py-2"><span className={`px-2 py-0.5 rounded text-xs ${issue.status === 'done' ? 'bg-green-600/20 text-green-400' : issue.status === 'in_progress' ? 'bg-yellow-600/20 text-yellow-400' : issue.status === 'in_review' ? 'bg-purple-600/20 text-purple-400' : 'bg-gray-600/20 text-gray-400'}`}>{issue.status.replace('_', ' ')}</span></td>
                          <td className="py-2">{PRIORITY_BADGES[issue.priority]?.label ?? '🟡'}</td>
                          <td className="py-2">{issue.created_by_profile?.avatar_url ? <img src={issue.created_by_profile.avatar_url} alt="" className="w-5 h-5 rounded-full object-cover inline" /> : <span className="inline-flex w-5 h-5 rounded-full bg-gray-600 text-[9px] text-gray-300 items-center justify-center">{issue.created_by_profile?.full_name?.charAt(0) ?? '?'}</span>}</td>
                          <td className="py-2 text-gray-500 text-xs">{new Date(issue.created_at).toLocaleDateString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            /* File Viewer Tab */
            <div className="flex-1 overflow-auto bg-gray-950">
              {(() => {
                const fc = fileContents[activeTab]
                if (!fc || fc.loading) {
                  return (
                    <div className="flex items-center justify-center h-full">
                      <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
                    </div>
                  )
                }
                const currentTab = fileTabs.find(t => t.id === activeTab)
                const isMarkdown = currentTab?.name.endsWith('.md')
                if (isMarkdown && fc.content) {
                  return (
                    <div className="p-6 prose prose-invert prose-sm max-w-none
                      [&_h1]:text-xl [&_h1]:font-bold [&_h1]:text-white [&_h1]:mt-4 [&_h1]:mb-2
                      [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-white [&_h2]:mt-3 [&_h2]:mb-2
                      [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-white [&_h3]:mt-2 [&_h3]:mb-1
                      [&_p]:text-gray-300 [&_p]:leading-relaxed [&_p]:mb-2
                      [&_ul]:pl-5 [&_ul]:mb-2 [&_ol]:pl-5 [&_ol]:mb-2
                      [&_li]:text-gray-300 [&_li]:mb-0.5
                      [&_code]:bg-gray-800 [&_code]:text-green-400 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs
                      [&_pre]:bg-gray-900 [&_pre]:border [&_pre]:border-gray-700 [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:my-2 [&_pre]:overflow-x-auto
                      [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-gray-300
                      [&_strong]:text-white [&_strong]:font-semibold
                      [&_a]:text-blue-400 [&_a]:underline
                      [&_blockquote]:border-l-2 [&_blockquote]:border-gray-600 [&_blockquote]:pl-3 [&_blockquote]:text-gray-400
                      [&_hr]:border-gray-700 [&_hr]:my-3
                    ">
                      <Markdown remarkPlugins={[remarkGfm]}>{fc.content}</Markdown>
                    </div>
                  )
                }
                return (
                  <pre className="p-4 text-xs text-gray-300 font-mono whitespace-pre-wrap leading-relaxed">{fc.content}</pre>
                )
              })()}
            </div>
          )}

          {/* WorkspaceActions bar — same as Chat page, shows Preview/Publish when app detected */}
          <WorkspaceActions
            sessionId={project?.workspace_session_id ?? null}
            refreshKey={wsRefreshKey}
          />
        </div>

        {/* Right Panel */}
        {renderRightPanel()}
      </div>

      {/* Agent Console (bottom panel) */}
      {showConsole && (
        <div
          className="border-t border-gray-800 bg-gray-900 flex flex-col flex-shrink-0"
          style={{ height: consoleHeight }}
        >
          {/* Console header */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-800 bg-gray-900/80">
            <div className="flex items-center gap-2">
              <Terminal size={14} className="text-green-400" />
              <span className="text-xs font-medium text-gray-300">{t('project.agentConsole')}</span>
              {consoleMessages.length > 0 && (
                <span className="text-[10px] text-gray-500">{consoleMessages.length} {t('project.consoleMessages')}</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setConsoleHeight(h => h === 200 ? 400 : 200)}
                className="p-1 text-gray-500 hover:text-white rounded transition-colors"
                title={consoleHeight === 200 ? t('project.consoleExpand') : t('project.consoleShrink')}
              >
                {consoleHeight === 200 ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
              <button
                onClick={() => setShowConsole(false)}
                className="p-1 text-gray-500 hover:text-white rounded transition-colors"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {/* Console messages */}
          <div className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs space-y-1.5">
            {consoleMessages.length === 0 ? (
              <div className="text-gray-600 text-center py-4">
                {project?.workspace_session_id
                  ? t('project.consoleWaiting')
                  : t('project.consoleNoSession')}
              </div>
            ) : (
              consoleMessages.map(msg => {
                // Parse content: AI messages may be JSON content blocks or plain text
                let displayContent = msg.content
                if (msg.type === 'ai' || msg.type === 'agent') {
                  try {
                    const blocks = JSON.parse(msg.content)
                    if (Array.isArray(blocks)) {
                      displayContent = blocks
                        .filter((b: { type: string }) => b.type === 'text')
                        .map((b: { text: string }) => b.text)
                        .join('\n')
                    }
                  } catch { /* plain text, use as-is */ }
                }
                return (
                  <div key={msg.id} className="flex gap-2">
                    <span className="text-gray-600 flex-shrink-0 w-16">
                      {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                    <span className={`flex-shrink-0 w-4 ${
                      msg.type === 'user' ? 'text-blue-400' :
                      msg.type === 'agent' || msg.type === 'ai' ? 'text-green-400' :
                      'text-gray-500'
                    }`}>
                      {msg.type === 'user' ? '→' : msg.type === 'agent' || msg.type === 'ai' ? '←' : '•'}
                    </span>
                    <span className={`flex-1 break-words whitespace-pre-wrap ${
                      msg.type === 'user' ? 'text-blue-300' :
                      msg.type === 'agent' || msg.type === 'ai' ? 'text-green-300' :
                      'text-gray-500'
                    }`}>
                      {displayContent.length > 800 ? displayContent.substring(0, 800) + '...' : displayContent}
                    </span>
                  </div>
                )
              })
            )}
            <div ref={consoleEndRef} />
          </div>
        </div>
      )}

      {/* Create Issue Dialog */}
      {showCreateIssue && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowCreateIssue(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-96 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-white mb-4">{t('project.newIssue')}</h3>
            <div className="space-y-3">
              <input value={newIssueTitle} onChange={e => setNewIssueTitle(e.target.value)} placeholder={t('project.issueTitlePlaceholder')} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500" autoFocus onKeyDown={e => e.key === 'Enter' && handleCreateIssue()} />
              <div className="grid grid-cols-2 gap-2">
                <select value={newIssueLane} onChange={e => setNewIssueLane(e.target.value)} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white outline-none">
                  {LANES.map(l => <option key={l.id} value={l.id}>{t(l.labelKey)}</option>)}
                </select>
                <select value={newIssuePriority} onChange={e => setNewIssuePriority(e.target.value)} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white outline-none">
                  <option value="critical">{t('project.criticalPriority')}</option>
                  <option value="high">{t('project.highPriority')}</option>
                  <option value="medium">{t('project.mediumPriority')}</option>
                  <option value="low">{t('project.lowPriority')}</option>
                </select>
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowCreateIssue(false)} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white">{t('common.cancel')}</button>
                <button onClick={handleCreateIssue} disabled={!newIssueTitle.trim()} className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white text-xs rounded-lg transition-colors">{t('common.create')}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Execute Confirmation Dialog */}
      {showExecuteConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowExecuteConfirm(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-[420px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-white mb-2">{t('project.startAgentExecution')}</h3>
            <p className="text-xs text-gray-400 mb-4">
              {t('project.movingToInProgress')} <span className="text-white font-medium">#{showExecuteConfirm.issue_number} {showExecuteConfirm.title}</span> {t('project.toInProgress')}
            </p>

            <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 mb-4">
              <div className="flex items-center gap-2 mb-2">
                <Bot size={16} className="text-purple-400" />
                <span className="text-xs text-gray-300">
                  {project?.agent_id ? t('project.projectAgent') : t('project.defaultAgent')}
                </span>
              </div>
              <p className="text-[10px] text-gray-500">
                {t('project.agentWillCreateBranch')}
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={() => setShowExecuteConfirm(null)} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white transition-colors">
                {t('common.cancel')}
              </button>
              <button onClick={handleSkipExecute} className="px-3 py-1.5 text-xs text-gray-300 hover:text-white border border-gray-600 rounded-lg transition-colors">
                {t('project.justMove')}
              </button>
              <button onClick={() => handleExecuteConfirm()} className="flex items-center gap-1 px-4 py-1.5 bg-green-600 hover:bg-green-500 text-white text-xs rounded-lg transition-colors">
                <Play size={12} /> {t('project.startAgent')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Issue Detail Panel */}
      {selectedIssue && (
        <div className="fixed inset-0 bg-black/60 flex justify-end z-50" onClick={() => setSelectedIssue(null)}>
          <div className="w-[480px] h-full bg-gray-900 border-l border-gray-700 flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">#{selectedIssue.issue_number}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded ${
                  editStatus === 'done' ? 'bg-green-600/20 text-green-400' :
                  editStatus === 'in_progress' ? 'bg-yellow-600/20 text-yellow-400' :
                  editStatus === 'in_review' ? 'bg-purple-600/20 text-purple-400' :
                  'bg-gray-600/20 text-gray-400'
                }`}>{editStatus.replace('_', ' ')}</span>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={handleDeleteSelectedIssue} className="p-1.5 text-gray-500 hover:text-red-400 rounded transition-colors" title={t('project.deleteIssue')}>
                  <X size={14} />
                </button>
                <button onClick={() => setSelectedIssue(null)} className="p-1.5 text-gray-500 hover:text-white rounded transition-colors">
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* Title */}
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('project.title')}</label>
                <input
                  value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white outline-none focus:border-blue-500"
                />
              </div>

              {/* Description */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-gray-400">{t('project.description')}</label>
                  {refinedDesc === null ? (
                    <button
                      onClick={async () => {
                        if (!projectId || !selectedIssue) return
                        setIsRefining(true)
                        try {
                          const improved = await RestProjectService.beautifyDescription(projectId, selectedIssue.id)
                          setRefinedDesc(improved)
                        } catch (err) {
                          console.error('Refine failed:', err)
                        } finally {
                          setIsRefining(false)
                        }
                      }}
                      disabled={isRefining}
                      className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-purple-400 hover:text-purple-300 hover:bg-purple-500/10 rounded transition-colors disabled:opacity-50"
                      title={t('project.aiBeautifyHint')}
                    >
                      {isRefining ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
                      {isRefining ? t('project.refining') : t('project.aiBeautify')}
                    </button>
                  ) : (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => { setEditDesc(refinedDesc); setRefinedDesc(null) }}
                        className="px-2 py-0.5 text-[10px] text-green-400 hover:text-green-300 hover:bg-green-500/10 rounded transition-colors"
                      >
                        {t('project.accept')}
                      </button>
                      <button
                        onClick={() => setRefinedDesc(null)}
                        className="px-2 py-0.5 text-[10px] text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded transition-colors"
                      >
                        {t('project.discard')}
                      </button>
                    </div>
                  )}
                </div>

                {refinedDesc !== null ? (
                  /* Diff view: before / after */
                  <div className="space-y-2">
                    <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-2.5">
                      <div className="flex items-center gap-1 mb-1.5">
                        <span className="text-[10px] font-medium text-red-400">{t('project.before')}</span>
                      </div>
                      <p className="text-xs text-gray-400 whitespace-pre-wrap leading-relaxed">
                        {editDesc || t('project.empty')}
                      </p>
                    </div>
                    <div className="rounded-lg border border-green-500/20 bg-green-500/5 p-2.5">
                      <div className="flex items-center gap-1 mb-1.5">
                        <span className="text-[10px] font-medium text-green-400">{t('project.afterRefined')}</span>
                      </div>
                      <p className="text-xs text-gray-300 whitespace-pre-wrap leading-relaxed">
                        {refinedDesc}
                      </p>
                    </div>
                  </div>
                ) : (
                  <textarea
                    value={editDesc}
                    onChange={e => setEditDesc(e.target.value)}
                    rows={12}
                    placeholder={t('project.descPlaceholder')}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500 resize-y min-h-[120px]"
                  />
                )}
              </div>

              {/* Status + Priority */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">{t('project.status')}</label>
                  <select value={editStatus} onChange={e => setEditStatus(e.target.value)} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white outline-none focus:border-blue-500">
                    {LANES.map(l => <option key={l.id} value={l.id}>{t(l.labelKey)}</option>)}
                    <option value="cancelled">{t('project.cancelled')}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">{t('project.priority')}</label>
                  <select value={editPriority} onChange={e => setEditPriority(e.target.value)} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white outline-none focus:border-blue-500">
                    <option value="critical">{t('project.criticalPriority')}</option>
                    <option value="high">{t('project.highPriority')}</option>
                    <option value="medium">{t('project.mediumPriority')}</option>
                    <option value="low">{t('project.lowPriority')}</option>
                  </select>
                </div>
              </div>

              {/* Branch info (if agent has worked on it) */}
              {selectedIssue.branch_name && (
                <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-3">
                  <div className="text-xs text-gray-400 mb-1">{t('project.branch')}</div>
                  <code className="text-xs text-blue-400">{selectedIssue.branch_name}</code>
                </div>
              )}

              {/* Code Changes / Diff */}
              {(selectedIssue.diff_stat || selectedIssue.status === 'in_review' || selectedIssue.status === 'done') && (
                <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <FileCode size={12} className="text-blue-400" />
                      <span className="text-xs font-medium text-gray-300">{t('project.changes')}</span>
                      {selectedIssue.diff_stat && (
                        <span className="text-[10px] text-gray-500">
                          {selectedIssue.diff_stat.files_changed} file{selectedIssue.diff_stat.files_changed !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    {selectedIssue.diff_stat && (
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-green-400">+{selectedIssue.diff_stat.insertions}</span>
                        <span className="text-[10px] text-red-400">-{selectedIssue.diff_stat.deletions}</span>
                        <button
                          onClick={async () => {
                            if (showDiffPanel) {
                              setShowDiffPanel(false)
                              return
                            }
                            if (!projectId || !selectedIssue) return
                            if (diffPatch !== null) {
                              setShowDiffPanel(true)
                              return
                            }
                            setLoadingDiff(true)
                            try {
                              const result = await RestProjectService.getIssueDiff(projectId, selectedIssue.id)
                              setDiffPatch(result.diff_patch)
                              setDiffStat(result.diff_stat)
                              setShowDiffPanel(true)
                            } catch (err) {
                              console.error('Failed to load diff:', err)
                            } finally {
                              setLoadingDiff(false)
                            }
                          }}
                          className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
                        >
                          {loadingDiff ? <Loader2 size={10} className="animate-spin" /> : showDiffPanel ? t('project.hideDiff') : t('project.viewDiff')}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* File list */}
                  {selectedIssue.diff_stat?.files && (
                    <div className="space-y-0.5 mb-2">
                      {selectedIssue.diff_stat.files.map((f, i) => (
                        <div key={i} className="flex items-center justify-between text-[10px]">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className={`flex-shrink-0 w-1 h-1 rounded-full ${
                              f.status === 'added' ? 'bg-green-400' :
                              f.status === 'deleted' ? 'bg-red-400' :
                              'bg-yellow-400'
                            }`} />
                            <span className="text-gray-300 truncate font-mono">{f.path}</span>
                          </div>
                          <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                            {f.insertions > 0 && <span className="text-green-400">+{f.insertions}</span>}
                            {f.deletions > 0 && <span className="text-red-400">-{f.deletions}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {!selectedIssue.diff_stat && (
                    <p className="text-[10px] text-gray-600">{t('project.noDiffYet')}</p>
                  )}

                  {/* Full diff view */}
                  {showDiffPanel && diffPatch && (
                    <div className="mt-2 border-t border-gray-700 pt-2">
                      <pre className="text-[10px] font-mono leading-relaxed overflow-x-auto max-h-80 overflow-y-auto">
                        {diffPatch.split('\n').map((line, i) => {
                          const cls = line.startsWith('+++') || line.startsWith('---') ? 'text-gray-500 font-bold'
                            : line.startsWith('@@') ? 'text-cyan-400'
                            : line.startsWith('+') ? 'text-green-400 bg-green-500/5'
                            : line.startsWith('-') ? 'text-red-400 bg-red-500/5'
                            : line.startsWith('diff ') ? 'text-gray-400 font-bold border-t border-gray-800 pt-1 mt-1'
                            : 'text-gray-500'
                          return <div key={i} className={cls}>{line || ' '}</div>
                        })}
                      </pre>
                    </div>
                  )}
                </div>
              )}

              {/* AI Acceptance Criteria */}
              {selectedIssue.acceptance_criteria && (selectedIssue.acceptance_criteria as Array<{ criterion: string; verified?: boolean }>).length > 0 && (
                <div className="bg-purple-500/5 border border-purple-500/10 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <Sparkles size={12} className="text-purple-400" />
                      <span className="text-xs font-medium text-purple-300">{t('project.acceptanceCriteria')}</span>
                    </div>
                    <span className="text-[10px] text-gray-500">{t('project.aiGenerated')}</span>
                  </div>
                  <div className="space-y-1">
                    {(selectedIssue.acceptance_criteria as Array<{ criterion: string; verified?: boolean }>).map((ac, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs text-gray-300">
                        <span className="mt-0.5 text-purple-400">•</span>
                        <span>{ac.criterion}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Issue Relations */}
              {issueRelations.length > 0 && (
                <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-3">
                  <div className="flex items-center gap-1.5 mb-2">
                    <span className="text-xs font-medium text-gray-300">{t('project.relations')}</span>
                    <span className="text-[10px] text-gray-500">({issueRelations.length})</span>
                  </div>
                  <div className="space-y-1.5">
                    {issueRelations.map(rel => {
                      const isSource = rel.source_issue_id === selectedIssue.id
                      const otherIssue = isSource ? rel.target_issue : rel.source_issue
                      const typeConfig = RELATION_TYPE_CONFIG[rel.relation_type] ?? { icon: '🔄', labelKey: 'project.relatedTo' }
                      return (
                        <div key={rel.id} className={`flex items-center justify-between p-2 rounded-lg border ${
                          rel.status === 'dismissed' ? 'opacity-40 border-gray-800' :
                          rel.relation_type === 'conflicts_with' ? 'border-red-500/20 bg-red-500/5' :
                          rel.relation_type === 'depends_on' ? 'border-blue-500/20 bg-blue-500/5' :
                          'border-gray-700 bg-gray-800/30'
                        }`}>
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            <span className="text-xs">{typeConfig.icon}</span>
                            <span className="text-[10px] text-gray-500">{t(typeConfig.labelKey)}</span>
                            <span className="text-xs text-white truncate">#{otherIssue.issue_number} {otherIssue.title}</span>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <span className="text-[10px] text-gray-500">{Math.round(rel.confidence * 100)}%</span>
                            {rel.status === 'pending' && (
                              <>
                                <button onClick={() => handleReviewRelation(rel.id, 'confirmed')} className="p-0.5 text-green-500/60 hover:text-green-400 rounded transition-colors" title="Confirm">✓</button>
                                <button onClick={() => handleReviewRelation(rel.id, 'dismissed')} className="p-0.5 text-red-500/60 hover:text-red-400 rounded transition-colors" title="Dismiss">✕</button>
                              </>
                            )}
                            {rel.status === 'confirmed' && <span className="text-[10px] text-green-500">{t('project.confirmed')}</span>}
                            {rel.status === 'dismissed' && <span className="text-[10px] text-gray-600">{t('project.dismissed')}</span>}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  {issueRelations.some(r => r.reasoning) && (
                    <details className="mt-2">
                      <summary className="text-[10px] text-gray-500 cursor-pointer hover:text-gray-400">{t('project.viewAiReasoning')}</summary>
                      <div className="mt-1 space-y-1">
                        {issueRelations.filter(r => r.reasoning).map(r => {
                          const other = r.source_issue_id === selectedIssue.id ? r.target_issue : r.source_issue
                          return (
                            <p key={r.id} className="text-[10px] text-gray-500 pl-2 border-l border-gray-700">
                              <span className="text-gray-400">#{other.issue_number}:</span> {r.reasoning}
                            </p>
                          )
                        })}
                      </div>
                    </details>
                  )}
                </div>
              )}

              {/* Readiness Score Breakdown */}
              {['backlog', 'todo'].includes(editStatus) && selectedIssue.readiness_details && (
                <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-gray-300">{t('project.readinessScore')}</span>
                    <div className="flex items-center gap-2">
                      {selectedIssue.ai_analysis_status === 'stale' && (
                        <button onClick={handleReanalyze} className="flex items-center gap-1 text-[10px] text-purple-400 hover:text-purple-300 transition-colors">
                          <RefreshCw size={10} /> {t('project.reanalyze')}
                        </button>
                      )}
                      <span className={`text-sm font-bold ${
                        (selectedIssue.readiness_score ?? 0) >= 80 ? 'text-green-400' :
                        (selectedIssue.readiness_score ?? 0) >= 50 ? 'text-yellow-400' : 'text-red-400'
                      }`}>{selectedIssue.readiness_score ?? 0}/100</span>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    {Object.entries(selectedIssue.readiness_details as Record<string, { score: number; max: number; reason: string }>).map(([key, detail]) => (
                      <div key={key}>
                        <div className="flex items-center justify-between text-[10px] mb-0.5">
                          <span className="text-gray-400 capitalize">{key}</span>
                          <span className="text-gray-500">{detail.score}/{detail.max}</span>
                        </div>
                        <div className="w-full h-1 bg-gray-700 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-300 ${
                              detail.score / detail.max >= 0.8 ? 'bg-green-500' :
                              detail.score / detail.max >= 0.5 ? 'bg-yellow-500' : 'bg-red-500'
                            }`}
                            style={{ width: `${(detail.score / detail.max) * 100}%` }}
                          />
                        </div>
                        <p className="text-[9px] text-gray-600 mt-0.5">{detail.reason}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Creator */}
              <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-3">
                <div className="text-xs text-gray-400 mb-1">{t('project.createdBy')}</div>
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium bg-gray-600 text-gray-300 overflow-hidden flex-shrink-0">
                    {selectedIssue.created_by_profile?.avatar_url ? (
                      <img src={selectedIssue.created_by_profile.avatar_url} alt="" className="w-full h-full object-cover" />
                    ) : (
                      selectedIssue.created_by_profile?.full_name?.charAt(0) ?? '?'
                    )}
                  </div>
                  <span className="text-sm text-gray-300">
                    {selectedIssue.created_by_profile?.full_name ?? selectedIssue.created_by_profile?.username ?? 'Unknown'}
                  </span>
                  <span className="text-xs text-gray-500 ml-auto">
                    {new Date(selectedIssue.created_at).toLocaleDateString()}
                  </span>
                </div>
              </div>

              {/* Project Agent */}
              <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-3">
                <div className="text-xs text-gray-400 mb-1">{t('project.projectAgent')}</div>
                <div className="flex items-center gap-2 text-sm">
                  {project?.agent_id ? (
                    <><Bot size={14} className="text-purple-400" /> <span className="text-gray-300">{t('project.customAgent')}</span></>
                  ) : (
                    <><Bot size={14} className="text-gray-500" /> <span className="text-gray-500">{t('project.defaultAgent')}</span></>
                  )}
                </div>
              </div>

              {/* Comments */}
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <MessageSquare size={12} className="text-gray-400" />
                  <label className="text-xs text-gray-400">
                    {t('project.comments')} {issueComments.length > 0 && `(${issueComments.length})`}
                  </label>
                </div>

                {loadingComments ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 size={14} className="text-gray-500 animate-spin" />
                  </div>
                ) : issueComments.length === 0 ? (
                  <p className="text-xs text-gray-600 py-2">{t('project.noComments')}</p>
                ) : (
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {issueComments.map(c => (
                      <div key={c.id} className={`rounded-lg p-2.5 text-xs ${
                        c.comment_type === 'status_change'
                          ? 'bg-yellow-500/5 border border-yellow-500/10'
                          : c.author_agent_id
                            ? 'bg-purple-500/5 border border-purple-500/10'
                            : 'bg-gray-800 border border-gray-700'
                      }`}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] text-gray-500">
                            {c.comment_type === 'status_change' ? '⚡ System' :
                             c.author_agent_id ? '🤖 Agent' : '👤 User'}
                          </span>
                          <span className="text-[10px] text-gray-600">
                            {new Date(c.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        <p className="text-gray-300 whitespace-pre-wrap break-words leading-relaxed">
                          {c.content.length > 500 ? c.content.substring(0, 500) + '...' : c.content}
                        </p>
                      </div>
                    ))}
                    <div ref={commentsEndRef} />
                  </div>
                )}

                {/* Add comment */}
                <div className="flex gap-2 mt-2">
                  <input
                    value={newComment}
                    onChange={e => setNewComment(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePostComment() } }}
                    placeholder={t('project.addComment')}
                    className="flex-1 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-white placeholder-gray-600 outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={handlePostComment}
                    disabled={postingComment || !newComment.trim()}
                    className="px-2.5 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg transition-colors"
                  >
                    {postingComment ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                  </button>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-800">
              <button onClick={() => setSelectedIssue(null)} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white transition-colors">
                {t('common.cancel')}
              </button>
              <button onClick={handleSaveIssue} disabled={isSavingIssue || !editTitle.trim()} className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white text-xs rounded-lg transition-colors">
                {isSavingIssue ? t('project.saving') : t('project.saveChanges')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Triage Report Slide-over */}
      {showTriageReport && triageReport && (
        <TriageReportPanel
          projectId={projectId!}
          report={triageReport}
          onClose={() => setShowTriageReport(false)}
          onDataChanged={loadData}
        />
      )}

      {/* Settings Modal */}
      {showSettings && (
        <ProjectSettingsModal
          project={project}
          autoProcess={autoProcess}
          onToggleAutoProcess={handleToggleAutoProcess}
          onClose={() => setShowSettings(false)}
          onProjectUpdated={(updated) => { setProject(updated); loadData() }}
        />
      )}
    </div>
  )
}

// ============================================================================
// Triage Report Panel — with action buttons
// ============================================================================

function TriageReportPanel({ projectId, report, onClose, onDataChanged }: {
  projectId: string
  report: TriageReport
  onClose: () => void
  onDataChanged: () => void
}) {
  const { t } = useTranslation()
  const [customInstruction, setCustomInstruction] = useState('')
  const [executing, setExecuting] = useState<string | null>(null) // action label being executed
  const [executionResult, setExecutionResult] = useState<ActionResult | null>(null)

  const suggestedActions = report.suggested_actions ?? []

  const handleExecuteAction = async (action: TriageAction) => {
    setExecuting(action.label)
    setExecutionResult(null)
    try {
      const result = await RestProjectService.executeTriageAction(projectId, action)
      setExecutionResult(result)
      if (result.success) onDataChanged()
    } catch (err) {
      setExecutionResult({ success: false, message: err instanceof Error ? err.message : '执行失败', changes: [] })
    } finally {
      setExecuting(null)
    }
  }

  const handleCustomExecute = async () => {
    if (!customInstruction.trim()) return
    setExecuting('custom')
    setExecutionResult(null)
    try {
      const result = await RestProjectService.executeCustomInstruction(projectId, customInstruction)
      setExecutionResult(result)
      if (result.success) {
        setCustomInstruction('')
        onDataChanged()
      }
    } catch (err) {
      setExecutionResult({ success: false, message: err instanceof Error ? err.message : '执行失败', changes: [] })
    } finally {
      setExecuting(null)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex justify-end z-50" onClick={onClose}>
      <div className="w-[520px] h-full bg-gray-900 border-l border-gray-700 flex flex-col shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-purple-400" />
            <span className="text-sm font-semibold text-white">{t('project.aiTriageReport')}</span>
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-500 hover:text-white rounded transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Report Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Summary */}
          <div className="bg-purple-500/5 border border-purple-500/10 rounded-lg p-3">
            <p className="text-xs text-gray-300 leading-relaxed">{report.summary}</p>
            <p className="text-[10px] text-gray-500 mt-2">{t('project.sprintCapacity')}: {report.sprint_estimate}</p>
          </div>

          {/* Recommended Order */}
          {report.recommended_order?.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-gray-300 mb-2">{t('project.recommendedOrder')}</h4>
              <div className="space-y-1">
                {report.recommended_order.map((item, i) => (
                  <div key={i} className="flex items-start gap-2 p-2 bg-gray-800/50 rounded-lg">
                    <span className="text-[10px] text-gray-500 font-mono w-4 flex-shrink-0 mt-0.5">{i + 1}.</span>
                    <div>
                      <span className="text-xs text-white">#{item.issue_number}</span>
                      <p className="text-[10px] text-gray-500 mt-0.5">{item.reason}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Merge Suggestions */}
          {report.merge_suggestions?.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-gray-300 mb-2">{t('project.mergeSuggestions')}</h4>
              {report.merge_suggestions.map((m, i) => (
                <div key={i} className="p-2 bg-orange-500/5 border border-orange-500/10 rounded-lg mb-1.5">
                  <div className="flex items-center gap-1 mb-1">
                    {m.issue_numbers.map(n => (
                      <span key={n} className="px-1.5 py-0.5 bg-gray-700 text-[10px] text-white rounded">#{n}</span>
                    ))}
                    <span className="text-[10px] text-gray-500">→</span>
                    <span className="text-[10px] text-orange-300">{m.suggested_title}</span>
                  </div>
                  <p className="text-[10px] text-gray-500">{m.reason}</p>
                </div>
              ))}
            </div>
          )}

          {/* Missing Info */}
          {report.missing_info?.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-gray-300 mb-2">{t('project.infoNeeded')}</h4>
              {report.missing_info.map((m, i) => (
                <div key={i} className="flex items-start gap-2 p-2 bg-yellow-500/5 border border-yellow-500/10 rounded-lg mb-1.5">
                  <span className="text-xs text-white flex-shrink-0">#{m.issue_number}</span>
                  <p className="text-[10px] text-yellow-300">{m.what_is_missing}</p>
                </div>
              ))}
            </div>
          )}

          {/* Risk Flags */}
          {report.risk_flags?.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-gray-300 mb-2">{t('project.riskFlags')}</h4>
              {report.risk_flags.map((r, i) => (
                <div key={i} className="flex items-start gap-2 p-2 bg-red-500/5 border border-red-500/10 rounded-lg mb-1.5">
                  <span className="text-xs text-white flex-shrink-0">#{r.issue_number}</span>
                  <p className="text-[10px] text-red-300">{r.risk}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Action Panel — fixed at bottom */}
        <div className="border-t border-gray-800 p-4 space-y-3 bg-gray-900/95 backdrop-blur-sm">
          {/* Execution result */}
          {executionResult && (
            <div className={`p-2.5 rounded-lg text-xs ${
              executionResult.success
                ? 'bg-green-500/10 border border-green-500/20 text-green-300'
                : 'bg-red-500/10 border border-red-500/20 text-red-300'
            }`}>
              {executionResult.success ? '✅' : '❌'} {executionResult.message}
              {executionResult.changes.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {executionResult.changes.map((c, i) => (
                    <div key={i} className="text-[10px] text-gray-400">
                      {c.issue_number > 0 ? `#${c.issue_number}` : '•'} {c.detail}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* AI Suggested Actions */}
          {suggestedActions.length > 0 && (
            <div>
              <div className="text-[10px] text-gray-500 mb-1.5">建议操作</div>
              <div className="flex flex-wrap gap-1.5">
                {suggestedActions.map((action, i) => (
                  <button
                    key={i}
                    onClick={() => handleExecuteAction(action)}
                    disabled={executing !== null}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] bg-gray-800 text-gray-200 border border-gray-700 rounded-lg hover:bg-gray-700 hover:border-blue-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title={action.description}
                  >
                    {executing === action.label ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : action.type === 'merge_issues' ? '🔗' : action.type === 'reorder' ? '📋' : action.type === 'update_description' ? '✏️' : action.type === 'change_priority' ? '⬆️' : '⚡'}
                    {action.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Custom instruction input */}
          <div>
            <div className="text-[10px] text-gray-500 mb-1.5">自定义操作</div>
            <div className="flex gap-2">
              <textarea
                value={customInstruction}
                onChange={e => setCustomInstruction(e.target.value)}
                placeholder="输入你想执行的操作，例如：把 #4 拆成两个子任务..."
                rows={2}
                className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-xs text-white placeholder-gray-600 outline-none focus:border-blue-500 resize-none"
                onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) handleCustomExecute() }}
              />
              <button
                onClick={handleCustomExecute}
                disabled={executing !== null || !customInstruction.trim()}
                className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-xs rounded-lg transition-colors self-end"
              >
                {executing === 'custom' ? <Loader2 size={12} className="animate-spin" /> : '执行'}
              </button>
            </div>
            <p className="text-[9px] text-gray-600 mt-1">⌘+Enter 快速执行</p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Project Settings Modal
// ============================================================================

function ProjectSettingsModal({ project, autoProcess, onToggleAutoProcess, onClose, onProjectUpdated }: {
  project: Project
  autoProcess: boolean
  onToggleAutoProcess: (enabled: boolean) => void
  onClose: () => void
  onProjectUpdated: (p: Project) => void
}) {
  const [scopes, setScopes] = useState<Array<{ id: string; name: string }>>([])
  const [agents, setAgents] = useState<Array<{ id: string; display_name: string; business_scope_id?: string | null }>>([])
  const [selectedScopeId, setSelectedScopeId] = useState(project.business_scope_id ?? '')
  const [localAutoProcess, setLocalAutoProcess] = useState(autoProcess)
  const [saving, setSaving] = useState(false)
  const { t } = useTranslation()

  // Project is "started" if it has a workspace session AND a scope configured.
  // If scope was never set, user should still be able to set it even if a session exists.
  const isStarted = !!project.workspace_session_id && !!project.business_scope_id
  const isDirty = selectedScopeId !== (project.business_scope_id ?? '') || localAutoProcess !== autoProcess

  useEffect(() => {
    void Promise.all([
      RestBusinessScopeService.getBusinessScopes().then(list => {
        setScopes(list.map(s => ({ id: s.id, name: s.name })))
      }),
      RestAgentService.getAgents().then((list: Array<{ id: string; displayName: string; businessScopeId?: string | null }>) => {
        setAgents(list.map(a => ({ id: a.id, display_name: a.displayName, business_scope_id: a.businessScopeId ?? null })))
      }),
    ]).catch(() => {})
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      // Save scope change (only if not started)
      if (!isStarted && selectedScopeId !== (project.business_scope_id ?? '')) {
        const updated = await RestProjectService.updateProject(project.id, {
          business_scope_id: selectedScopeId || undefined,
        })
        onProjectUpdated(updated)
      }
      // Save auto-process toggle
      if (localAutoProcess !== autoProcess) {
        onToggleAutoProcess(localAutoProcess)
      }
      onClose()
    } catch (err) {
      console.error('Failed to save settings:', err)
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    onClose()
  }

  const noScope = !selectedScopeId

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={handleCancel}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-[420px] max-h-[85vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-white">{t('project.settings')}</h3>
          <button onClick={handleCancel} className="text-gray-500 hover:text-white"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-4">
          {/* Business Scope — locked after project starts */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">{t('project.businessScope')}</label>
            {isStarted ? (
              <>
                <div className="w-full px-3 py-2 bg-gray-800/50 border border-gray-700 rounded-lg text-sm text-gray-300 cursor-not-allowed">
                  {scopes.find(s => s.id === selectedScopeId)?.name || selectedScopeId || '未设置'}
                </div>
                <p className="text-[10px] text-gray-500 mt-1">
                  🔒 项目已启动，业务智能体范围不可更改
                </p>
              </>
            ) : (
              <>
                <select
                  value={selectedScopeId}
                  onChange={e => setSelectedScopeId(e.target.value)}
                  className={`w-full px-3 py-2 bg-gray-800 border rounded-lg text-sm text-white outline-none focus:border-blue-500 ${
                    noScope ? 'border-yellow-500/50' : 'border-gray-700'
                  }`}
                >
                  <option value="">{t('project.noScopeOption')}</option>
                  {scopes.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                {noScope && (
                  <p className="text-[10px] text-yellow-400 mt-1">
                    {t('project.noScopeWarning')}
                  </p>
                )}
              </>
            )}
          </div>

          <div className="border-t border-gray-800 pt-4">
            {/* Auto-process toggle */}
            <label className="flex items-center justify-between px-3 py-3 bg-gray-800 border border-gray-700 rounded-lg cursor-pointer hover:border-gray-600 transition-colors">
              <div>
                <div className="text-sm text-white">{t('project.autoProcess')}</div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {t('project.autoProcessDesc')}
                </div>
              </div>
              <div className="ml-4 flex-shrink-0">
                <button
                  onClick={() => setLocalAutoProcess(!localAutoProcess)}
                  className={`relative w-10 h-5 rounded-full transition-colors ${localAutoProcess ? 'bg-green-600' : 'bg-gray-600'}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${localAutoProcess ? 'left-5.5 translate-x-0.5' : 'left-0.5'}`} />
                </button>
              </div>
            </label>
          </div>

          {/* Project Squad */}
          <div className="border-t border-gray-800 pt-4">
            <ProjectSquadPanel projectId={project.id} agents={agents} projectScopeId={selectedScopeId} />
          </div>
        </div>

        {/* Footer: Save / Cancel */}
        <div className="mt-4 pt-4 border-t border-gray-800 flex justify-end gap-2">
          <button onClick={handleCancel} className="px-4 py-2 text-xs text-gray-400 hover:text-white transition-colors">
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !isDirty}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-xs font-medium rounded-lg transition-colors"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Project Squad Panel — manage multi-agent team
// ============================================================================

const SQUAD_ROLES = ['leader', 'frontend', 'backend', 'qa', 'devops', 'worker'] as const

function ProjectSquadPanel({ projectId, agents, projectScopeId }: { projectId: string; agents: Array<{ id: string; display_name: string; business_scope_id?: string | null }>; projectScopeId?: string }) {
  const { t } = useTranslation()
  const [squadAgents, setSquadAgents] = useState<ProjectAgent[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddAgent, setShowAddAgent] = useState(false)
  const [selectedAgentToAdd, setSelectedAgentToAdd] = useState('')
  const [selectedRole, setSelectedRole] = useState('worker')
  const [labelInput, setLabelInput] = useState('')
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState(false)
  const [recommending, setRecommending] = useState(false)
  const [recommendations, setRecommendations] = useState<Array<{ agent_id: string; agent_name: string; suggested_role: string; reason: string; auto_assign_labels: string[] }>>([])
  const [savedMsg, setSavedMsg] = useState<string | null>(null)

  const showSaved = (msg: string) => {
    setSavedMsg(msg)
    setTimeout(() => setSavedMsg(null), 2000)
  }

  const loadSquad = useCallback(async () => {
    try {
      const list = await RestProjectService.listProjectAgents(projectId)
      setSquadAgents(list)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [projectId])

  useEffect(() => { loadSquad() }, [loadSquad])

  const handleAdd = async () => {
    if (!selectedAgentToAdd) return
    setAdding(true)
    try {
      const labels = labelInput.trim() ? labelInput.split(',').map(l => l.trim()).filter(Boolean) : []
      await RestProjectService.addProjectAgent(projectId, {
        agent_id: selectedAgentToAdd,
        role: selectedRole,
        is_leader: selectedRole === 'leader',
        auto_assign_labels: labels,
      })
      setShowAddAgent(false)
      setSelectedAgentToAdd('')
      setSelectedRole('worker')
      setLabelInput('')
      loadSquad()
      showSaved('已添加')
    } catch (err) {
      console.error('Failed to add agent:', err)
    } finally { setAdding(false) }
  }

  const handleRemove = async (agentId: string) => {
    try {
      await RestProjectService.removeProjectAgent(projectId, agentId)
      loadSquad()
      showSaved('已移除')
    } catch (err) {
      console.error('Failed to remove agent:', err)
    }
  }

  const handlePromoteLeader = async (agentId: string) => {
    try {
      await RestProjectService.updateProjectAgent(projectId, agentId, { is_leader: true, role: 'leader' })
      loadSquad()
      showSaved('已设为 Leader')
    } catch (err) {
      console.error('Failed to promote agent:', err)
    }
  }

  const handleImportFromScope = async () => {
    setImporting(true)
    try {
      const result = await RestProjectService.importScopeAgents(projectId)
      if (result.imported > 0) {
        loadSquad()
        showSaved(`已导入 ${result.imported} 个 Agent`)
      } else {
        showSaved('所有 Agent 已在团队中')
      }
    } catch (err) {
      console.error('Failed to import from scope:', err)
    } finally { setImporting(false) }
  }

  const handleRecommend = async () => {
    setRecommending(true)
    setRecommendations([])
    try {
      const result = await RestProjectService.recommendSquad(projectId)
      setRecommendations(result.recommendations)
    } catch (err) {
      console.error('Failed to get recommendations:', err)
    } finally { setRecommending(false) }
  }

  const handleAcceptRecommendation = async (rec: { agent_id: string; suggested_role: string; auto_assign_labels: string[] }) => {
    try {
      await RestProjectService.addProjectAgent(projectId, {
        agent_id: rec.agent_id,
        role: rec.suggested_role,
        is_leader: rec.suggested_role === 'leader',
        auto_assign_labels: rec.auto_assign_labels,
      })
      setRecommendations(prev => prev.filter(r => r.agent_id !== rec.agent_id))
      loadSquad()
      showSaved('已采纳')
    } catch (err) {
      console.error('Failed to add recommended agent:', err)
    }
  }

  // For manual add: only show agents from OTHER scopes (same-scope agents use "导入Scope")
  const squadAgentIds = new Set(squadAgents.map(a => a.agent_id))
  const availableAgents = agents.filter(a => {
    if (squadAgentIds.has(a.id)) return false
    // Exclude agents from the project's own scope (those should use "导入Scope")
    if (projectScopeId && a.business_scope_id === projectScopeId) return false
    return true
  })

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <Bot size={14} className="text-purple-400" />
          <span className="text-xs font-medium text-gray-300">项目团队</span>
          <span className="text-[10px] text-gray-500">({squadAgents.length})</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleImportFromScope}
            disabled={importing}
            className="flex items-center gap-1 px-2 py-1 text-[10px] text-green-400 hover:text-green-300 hover:bg-green-500/10 rounded transition-colors disabled:opacity-50"
            title="从业务域导入所有 Agent"
          >
            {importing ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />}
            导入Scope
          </button>
          <button
            onClick={handleRecommend}
            disabled={recommending}
            className="flex items-center gap-1 px-2 py-1 text-[10px] text-purple-400 hover:text-purple-300 hover:bg-purple-500/10 rounded transition-colors disabled:opacity-50"
            title="AI 推荐适合此项目的 Agent"
          >
            {recommending ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
            AI推荐
          </button>
          <button
            onClick={() => setShowAddAgent(!showAddAgent)}
            className="flex items-center gap-1 px-2 py-1 text-[10px] text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 rounded transition-colors"
          >
            <Plus size={10} /> 手动
          </button>
        </div>
      </div>
      <p className="text-[9px] text-gray-600 mb-2">
        团队变更即时生效
        {savedMsg && <span className="ml-2 text-green-400 animate-pulse">✓ {savedMsg}</span>}
      </p>

      {loading ? (
        <div className="flex items-center justify-center py-4">
          <Loader2 size={14} className="text-gray-500 animate-spin" />
        </div>
      ) : squadAgents.length === 0 ? (
        <p className="text-[10px] text-gray-600 py-2">暂无团队成员。添加 Agent 来组建项目小队。</p>
      ) : (
        <div className="space-y-1.5">
          {squadAgents.map(pa => (
            <div key={pa.id} className="flex items-center gap-2 px-2.5 py-2 bg-gray-800 border border-gray-700 rounded-lg group">
              <div className="w-6 h-6 rounded-full bg-gradient-to-br from-purple-500/30 to-blue-500/30 border border-purple-500/20 flex items-center justify-center text-[10px] text-purple-300 flex-shrink-0">
                {pa.agent.display_name.charAt(0)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-white truncate">{pa.agent.display_name}</span>
                  {pa.is_leader && (
                    <Crown size={10} className="text-yellow-400 flex-shrink-0" />
                  )}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0 ${
                    pa.is_leader ? 'bg-yellow-500/15 text-yellow-400 border border-yellow-500/20' :
                    pa.role === 'frontend' ? 'bg-blue-500/15 text-blue-400 border border-blue-500/20' :
                    pa.role === 'backend' ? 'bg-green-500/15 text-green-400 border border-green-500/20' :
                    pa.role === 'qa' ? 'bg-orange-500/15 text-orange-400 border border-orange-500/20' :
                    'bg-gray-700 text-gray-400 border border-gray-600'
                  }`}>
                    {pa.role}
                  </span>
                </div>
                {pa.auto_assign_labels.length > 0 && (
                  <div className="flex items-center gap-1 mt-0.5">
                    <Tag size={8} className="text-gray-600" />
                    {pa.auto_assign_labels.map((label, i) => (
                      <span key={i} className="text-[9px] text-gray-500">{label}</span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {!pa.is_leader && (
                  <button
                    onClick={() => handlePromoteLeader(pa.agent_id)}
                    className="p-1 text-gray-500 hover:text-yellow-400 rounded transition-colors"
                    title="设为 Leader"
                  >
                    <Crown size={11} />
                  </button>
                )}
                <button
                  onClick={() => handleRemove(pa.agent_id)}
                  className="p-1 text-gray-500 hover:text-red-400 rounded transition-colors"
                  title="移除"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* AI Recommendations */}
      {recommendations.length > 0 && (
        <div className="mt-3 p-2.5 bg-purple-500/5 border border-purple-500/15 rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              <Sparkles size={11} className="text-purple-400" />
              <span className="text-[10px] font-medium text-purple-300">AI 推荐</span>
              <span className="text-[9px] text-gray-500">({recommendations.length})</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  for (const rec of recommendations) {
                    await handleAcceptRecommendation(rec)
                  }
                  setRecommendations([])
                }}
                className="px-2 py-1 text-[10px] text-green-400 hover:text-green-300 hover:bg-green-500/10 rounded border border-green-500/20 transition-colors"
              >
                全部采纳
              </button>
              <button
                onClick={() => setRecommendations([])}
                className="px-2 py-1 text-[10px] text-gray-500 hover:text-gray-400 transition-colors"
              >
                忽略
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            {recommendations.map(rec => (
              <div key={rec.agent_id} className="flex items-center gap-2 px-2 py-1.5 bg-gray-800/50 rounded-lg">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-white truncate">{rec.agent_name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/15 text-purple-400 border border-purple-500/20">
                      {rec.suggested_role}
                    </span>
                  </div>
                  <p className="text-[9px] text-gray-500 mt-0.5 truncate">{rec.reason}</p>
                </div>
                <button
                  onClick={() => handleAcceptRecommendation(rec)}
                  className="px-2 py-1 text-[10px] text-green-400 hover:text-green-300 hover:bg-green-500/10 rounded transition-colors flex-shrink-0"
                >
                  采纳
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add Agent Form — only shows cross-scope agents (same-scope agents use "导入Scope") */}
      {showAddAgent && (
        <div className="mt-2 p-3 bg-gray-800/50 border border-gray-700 rounded-lg space-y-2">
          <div className="text-[10px] text-gray-500 mb-1">仅显示其他业务域的 Agent（当前域请用"导入Scope"）</div>
          <select
            value={selectedAgentToAdd}
            onChange={e => setSelectedAgentToAdd(e.target.value)}
            className="w-full px-2.5 py-1.5 bg-gray-900 border border-gray-700 rounded text-xs text-white outline-none focus:border-blue-500"
          >
            <option value="">选择跨域 Agent...</option>
            {availableAgents.map(a => (
              <option key={a.id} value={a.id}>{a.display_name}</option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <select
              value={selectedRole}
              onChange={e => setSelectedRole(e.target.value)}
              className="px-2.5 py-1.5 bg-gray-900 border border-gray-700 rounded text-xs text-white outline-none focus:border-blue-500"
            >
              {SQUAD_ROLES.map(r => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            <input
              value={labelInput}
              onChange={e => setLabelInput(e.target.value)}
              placeholder="自动分配标签 (逗号分隔)"
              className="px-2.5 py-1.5 bg-gray-900 border border-gray-700 rounded text-xs text-white placeholder-gray-600 outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowAddAgent(false)} className="px-2 py-1 text-[10px] text-gray-400 hover:text-white">取消</button>
            <button
              onClick={handleAdd}
              disabled={adding || !selectedAgentToAdd}
              className="px-3 py-1 text-[10px] bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors"
            >
              {adding ? '...' : '添加'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Issue Card
// ============================================================================

function ReadinessRing({ score, size = 28 }: { score: number; size?: number }) {
  const radius = (size - 4) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (score / 100) * circumference
  const color = score >= 80 ? '#4ade80' : score >= 50 ? '#facc15' : '#f87171'
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }} title={`Readiness: ${score}%`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size/2} cy={size/2} r={radius} fill="none" stroke="#374151" strokeWidth={2} />
        <circle cx={size/2} cy={size/2} r={radius} fill="none" stroke={color} strokeWidth={2}
          strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round"
          className="transition-all duration-500"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold" style={{ color }}>
        {score}
      </span>
    </div>
  )
}

function IssueCard({ issue, relations, onDragStart, onClick }: { issue: ProjectIssue; relations?: IssueRelation[]; onDragStart: () => void; onClick: () => void }) {
  const { t } = useTranslation()
  const priority = PRIORITY_BADGES[issue.priority]
  const isWorking = issue.status === 'in_progress' && issue.workspace_session_id
  const isAnalyzing = issue.ai_analysis_status === 'analyzing'
  const profile = issue.created_by_profile
  const creatorInitial = profile?.full_name?.charAt(0) ?? profile?.username?.charAt(0) ?? '?'

  const pendingConflicts = relations?.filter(r => r.relation_type === 'conflicts_with' && r.status === 'pending') ?? []
  const pendingDeps = relations?.filter(r => r.relation_type === 'depends_on' && r.status === 'pending') ?? []
  const duplicates = relations?.filter(r => r.relation_type === 'duplicates' && r.status === 'pending') ?? []
  const readiness = issue.readiness_score ?? null
  const showReadiness = ['backlog', 'todo'].includes(issue.status) && readiness !== null

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      className={`bg-gray-800 border rounded-lg p-3 cursor-grab active:cursor-grabbing hover:border-gray-600 transition-colors group ${
        pendingConflicts.length > 0 ? 'border-red-500/40' :
        isWorking ? 'border-yellow-500/50' : 'border-gray-700'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-[10px] text-gray-500">#{issue.issue_number}</span>
            {priority && <span className={`text-xs ${priority.cls}`}>{priority.label}</span>}
            {isWorking && (
              <span className="flex items-center gap-0.5 text-[10px] text-yellow-400">
                <Bot size={10} className="animate-pulse" /> {t('project.issueWorking')}
              </span>
            )}
            {isAnalyzing && (
              <span className="flex items-center gap-0.5 text-[10px] text-purple-400">
                <Sparkles size={10} className="animate-pulse" /> {t('project.issueAnalyzing')}
              </span>
            )}
          </div>
          <p className="text-xs text-white font-medium leading-snug">{issue.title}</p>
        </div>
        {showReadiness ? (
          <ReadinessRing score={readiness} size={28} />
        ) : (
          <GripVertical size={12} className="text-gray-600 flex-shrink-0 mt-0.5" />
        )}
      </div>
      <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-1 flex-wrap">
          {issue.labels.map((label: string, i: number) => (
            <span key={i} className="px-1.5 py-0.5 bg-gray-700 text-[10px] text-gray-400 rounded">{label}</span>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          {pendingConflicts.length > 0 && (
            <span className="flex items-center gap-0.5 px-1.5 py-0.5 bg-red-500/10 border border-red-500/20 rounded text-[10px] text-red-400" title={`${pendingConflicts.length} conflict(s)`}>
              ⚠️ {pendingConflicts.length}
            </span>
          )}
          {pendingDeps.length > 0 && (
            <span className="flex items-center gap-0.5 px-1.5 py-0.5 bg-blue-500/10 border border-blue-500/20 rounded text-[10px] text-blue-400" title={`${pendingDeps.length} dependency(ies)`}>
              🔗 {pendingDeps.length}
            </span>
          )}
          {duplicates.length > 0 && (
            <span className="px-1.5 py-0.5 bg-orange-500/10 border border-orange-500/20 rounded text-[10px] text-orange-400" title="Possible duplicate">
              📋
            </span>
          )}
          {issue._count?.comments ? (
            <span className="flex items-center gap-0.5 text-[10px] text-gray-500">
              <MessageSquare size={10} /> {issue._count.comments}
            </span>
          ) : null}
          {issue.assigned_agent_id && (
            <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-medium bg-purple-600/30 border border-purple-500/30 text-purple-300 flex-shrink-0" title="Assigned agent">
              <Bot size={10} />
            </div>
          )}
          <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-medium bg-gray-600 text-gray-300 overflow-hidden flex-shrink-0" title={profile?.full_name ?? 'Creator'}>
            {profile?.avatar_url ? (
              <img src={profile.avatar_url} alt="" className="w-full h-full object-cover" />
            ) : (
              creatorInitial
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
