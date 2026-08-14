/**
 * Knowledge Base Drive — 网盘化知识库管理页面
 *
 * 设计参考 Google Drive / 百度网盘，让用户像管理文件一样管理知识库。
 * 支持：多知识库切换、文件夹导航、标签、搜索、批量操作。
 */

import { useState, useEffect, useCallback } from 'react'
import {
  Plus, Search, FolderPlus, Upload, Trash2, Tag, Move,
  ChevronRight, Folder, FileText, Star, MoreHorizontal,
  ArrowLeft, CheckSquare, Square, Loader2, AlertCircle,
  Database, File as FileIcon, Image, Table2,
} from 'lucide-react'
import { useTranslation } from '@/i18n'
import { KnowledgeBaseAPI, type KnowledgeBase, type KnowledgeFolder, type KnowledgeFile, type PaginatedFiles } from '@/services/knowledgeBaseService'

// ============================================================================
// Helper Components
// ============================================================================

function FileTypeIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith('image/')) return <Image className="w-5 h-5 text-purple-400" />
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return <Table2 className="w-5 h-5 text-green-400" />
  if (mimeType.includes('pdf')) return <FileIcon className="w-5 h-5 text-red-400" />
  return <FileText className="w-5 h-5 text-blue-400" />
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return '刚刚'
  if (diffMins < 60) return `${diffMins} 分钟前`
  if (diffHours < 24) return `${diffHours} 小时前`
  if (diffDays < 7) return `${diffDays} 天前`
  return date.toLocaleDateString('zh-CN')
}

function IndexStatusBadge({ status }: { status: string }) {
  const config: Record<string, { bg: string; text: string; label: string }> = {
    indexed: { bg: 'bg-green-900/30', text: 'text-green-400', label: '已索引' },
    indexing: { bg: 'bg-blue-900/30', text: 'text-blue-400', label: '索引中' },
    pending: { bg: 'bg-yellow-900/30', text: 'text-yellow-400', label: '待索引' },
    failed: { bg: 'bg-red-900/30', text: 'text-red-400', label: '索引失败' },
  }
  const c = config[status] || config.pending
  return (
    <span className={`px-2 py-0.5 rounded text-xs ${c.bg} ${c.text}`}>{c.label}</span>
  )
}

// ============================================================================
// Main Page Component
// ============================================================================

export function KnowledgeBaseDrive() {
  const { t } = useTranslation()

  // Knowledge base list
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [selectedKb, setSelectedKb] = useState<KnowledgeBase | null>(null)
  const [isLoadingKbs, setIsLoadingKbs] = useState(true)

  // Folder navigation
  const [folders, setFolders] = useState<KnowledgeFolder[]>([])
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null)
  const [breadcrumbs, setBreadcrumbs] = useState<{ id: string | null; name: string }[]>([])

  // Files
  const [filesData, setFilesData] = useState<PaginatedFiles | null>(null)
  const [isLoadingFiles, setIsLoadingFiles] = useState(false)

  // Selection
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set())

  // Search
  const [searchQuery, setSearchQuery] = useState('')

  // Dialogs
  const [showCreateKb, setShowCreateKb] = useState(false)
  const [showCreateFolder, setShowCreateFolder] = useState(false)
  const [newKbName, setNewKbName] = useState('')
  const [newKbDescription, setNewKbDescription] = useState('')
  const [newFolderName, setNewFolderName] = useState('')
  const [isUploading, setIsUploading] = useState(false)

  // Error
  const [error, setError] = useState<string | null>(null)

  // --------------------------------------------------------------------------
  // Load knowledge bases
  // --------------------------------------------------------------------------

  const loadKnowledgeBases = useCallback(async () => {
    setIsLoadingKbs(true)
    try {
      const kbs = await KnowledgeBaseAPI.list()
      setKnowledgeBases(kbs)
      if (kbs.length > 0 && !selectedKb) {
        setSelectedKb(kbs[0])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载知识库失败')
    } finally {
      setIsLoadingKbs(false)
    }
  }, [selectedKb])

  useEffect(() => { loadKnowledgeBases() }, []) // eslint-disable-line

  // --------------------------------------------------------------------------
  // Load folders and files when KB or folder changes
  // --------------------------------------------------------------------------

  const loadContents = useCallback(async () => {
    if (!selectedKb) return
    setIsLoadingFiles(true)
    setError(null)
    try {
      const [folderList, fileList] = await Promise.all([
        KnowledgeBaseAPI.listFolders(selectedKb.id, currentFolderId),
        KnowledgeBaseAPI.listFiles(selectedKb.id, {
          folderId: currentFolderId,
          search: searchQuery || undefined,
        }),
      ])
      setFolders(folderList)
      setFilesData(fileList)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载文件失败')
    } finally {
      setIsLoadingFiles(false)
    }
  }, [selectedKb, currentFolderId, searchQuery])

  useEffect(() => { loadContents() }, [loadContents])

  // --------------------------------------------------------------------------
  // Navigation
  // --------------------------------------------------------------------------

  const navigateToFolder = (folder: KnowledgeFolder) => {
    setCurrentFolderId(folder.id)
    setBreadcrumbs(prev => [...prev, { id: folder.id, name: folder.name }])
    setSelectedFileIds(new Set())
  }

  const navigateToBreadcrumb = (index: number) => {
    if (index === -1) {
      // Root
      setCurrentFolderId(null)
      setBreadcrumbs([])
    } else {
      const crumb = breadcrumbs[index]
      setCurrentFolderId(crumb.id)
      setBreadcrumbs(prev => prev.slice(0, index + 1))
    }
    setSelectedFileIds(new Set())
  }

  const selectKnowledgeBase = (kb: KnowledgeBase) => {
    setSelectedKb(kb)
    setCurrentFolderId(null)
    setBreadcrumbs([])
    setSelectedFileIds(new Set())
    setSearchQuery('')
  }

  // --------------------------------------------------------------------------
  // Selection
  // --------------------------------------------------------------------------

  const toggleFileSelection = (fileId: string) => {
    setSelectedFileIds(prev => {
      const next = new Set(prev)
      if (next.has(fileId)) next.delete(fileId)
      else next.add(fileId)
      return next
    })
  }

  const selectAll = () => {
    if (!filesData) return
    if (selectedFileIds.size === filesData.items.length) {
      setSelectedFileIds(new Set())
    } else {
      setSelectedFileIds(new Set(filesData.items.map(f => f.id)))
    }
  }

  // --------------------------------------------------------------------------
  // Actions
  // --------------------------------------------------------------------------

  const handleCreateKb = async () => {
    if (!newKbName.trim()) return
    try {
      const kb = await KnowledgeBaseAPI.create({ name: newKbName.trim(), description: newKbDescription.trim() || undefined })
      setKnowledgeBases(prev => [kb, ...prev])
      setSelectedKb(kb)
      setShowCreateKb(false)
      setNewKbName('')
      setNewKbDescription('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建知识库失败')
    }
  }

  const handleCreateFolder = async () => {
    if (!selectedKb || !newFolderName.trim()) return
    try {
      await KnowledgeBaseAPI.createFolder(selectedKb.id, newFolderName.trim(), currentFolderId || undefined)
      setShowCreateFolder(false)
      setNewFolderName('')
      loadContents()
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建文件夹失败')
    }
  }

  const handleBatchDelete = async () => {
    if (!selectedKb || selectedFileIds.size === 0) return
    if (!confirm(`确定删除选中的 ${selectedFileIds.size} 个文件？`)) return
    try {
      await KnowledgeBaseAPI.batchOperation(selectedKb.id, 'delete', [...selectedFileIds])
      setSelectedFileIds(new Set())
      loadContents()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  const handleToggleStar = async (file: KnowledgeFile) => {
    if (!selectedKb) return
    try {
      await KnowledgeBaseAPI.updateFile(selectedKb.id, file.id, { is_starred: !file.is_starred })
      loadContents()
    } catch (err) {
      // Silently fail for star toggle
    }
  }

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (!files || files.length === 0 || !selectedKb) return

    setIsUploading(true)
    setError(null)

    try {
      for (const file of Array.from(files)) {
        const formData = new FormData()
        formData.append('file', file)

        const token = localStorage.getItem('local_auth_token') || localStorage.getItem('cognito_id_token')
        const baseUrl = import.meta.env.VITE_API_BASE_URL ?? ''
        const folderParam = currentFolderId ? `?folder_id=${currentFolderId}` : ''

        const res = await fetch(
          `${baseUrl}/api/knowledge-bases/${selectedKb.id}/files/upload${folderParam}`,
          {
            method: 'POST',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            body: formData,
          }
        )

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Upload failed' }))
          throw new Error(err.error || `上传失败: ${file.name}`)
        }
      }
      loadContents()
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败')
    } finally {
      setIsUploading(false)
      // Reset input
      event.target.value = ''
    }
  }

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <div className="h-full flex flex-col bg-gray-950">
      {/* Error Banner */}
      {error && (
        <div className="px-6 py-2 bg-red-900/30 border-b border-red-800 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400" />
          <span className="text-sm text-red-300">{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-300 text-sm">✕</button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center gap-4 px-6 py-4 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <Database className="w-5 h-5 text-blue-400" />
          <h1 className="text-lg font-semibold text-white">知识库</h1>
        </div>

        {/* KB Selector */}
        <select
          value={selectedKb?.id || ''}
          onChange={(e) => {
            const kb = knowledgeBases.find(k => k.id === e.target.value)
            if (kb) selectKnowledgeBase(kb)
          }}
          className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white"
        >
          {knowledgeBases.map(kb => (
            <option key={kb.id} value={kb.id}>{kb.icon || '📚'} {kb.name}</option>
          ))}
        </select>

        <button
          onClick={() => setShowCreateKb(true)}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm text-white flex items-center gap-1"
        >
          <Plus className="w-4 h-4" /> 新建知识库
        </button>

        {/* Search */}
        <div className="flex-1 max-w-md ml-auto relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索文件..."
            className="w-full pl-9 pr-4 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:border-blue-500 outline-none"
          />
        </div>
      </div>

      {/* Breadcrumbs + Actions */}
      {selectedKb && (
        <div className="flex items-center gap-2 px-6 py-2 border-b border-gray-800/50 text-sm">
          {/* Breadcrumbs */}
          <nav className="flex items-center gap-1 text-gray-400">
            <button
              onClick={() => navigateToBreadcrumb(-1)}
              className="hover:text-white transition-colors"
            >
              {selectedKb.name}
            </button>
            {breadcrumbs.map((crumb, i) => (
              <span key={crumb.id} className="flex items-center gap-1">
                <ChevronRight className="w-3 h-3" />
                <button
                  onClick={() => navigateToBreadcrumb(i)}
                  className="hover:text-white transition-colors"
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </nav>

          <div className="flex-1" />

          {/* Toolbar */}
          <label className="px-2 py-1 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors flex items-center gap-1 cursor-pointer">
            <Upload className="w-4 h-4" />
            {isUploading ? '上传中...' : '上传文件'}
            <input
              type="file"
              multiple
              onChange={handleFileUpload}
              disabled={isUploading}
              className="hidden"
              accept=".pdf,.txt,.md,.docx,.doc,.xlsx,.xls,.csv,.pptx,.ppt,.json,.yaml,.yml"
            />
          </label>

          <button
            onClick={() => setShowCreateFolder(true)}
            className="px-2 py-1 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors flex items-center gap-1"
          >
            <FolderPlus className="w-4 h-4" /> 新建文件夹
          </button>

          {selectedFileIds.size > 0 && (
            <div className="flex items-center gap-1 ml-2 pl-2 border-l border-gray-700">
              <span className="text-gray-400 text-xs">已选 {selectedFileIds.size} 项</span>
              <button
                onClick={handleBatchDelete}
                className="px-2 py-1 text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded transition-colors flex items-center gap-1"
              >
                <Trash2 className="w-3.5 h-3.5" /> 删除
              </button>
            </div>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {isLoadingKbs || isLoadingFiles ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
          </div>
        ) : !selectedKb ? (
          <EmptyState onCreateKb={() => setShowCreateKb(true)} />
        ) : (
          <div className="p-6">
            {/* Folders */}
            {folders.length > 0 && (
              <div className="mb-6">
                <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">文件夹</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                  {folders.map(folder => (
                    <button
                      key={folder.id}
                      onClick={() => navigateToFolder(folder)}
                      className="flex items-center gap-2 px-3 py-2.5 bg-gray-900 border border-gray-800 rounded-lg hover:border-gray-700 hover:bg-gray-800/50 transition-colors text-left"
                    >
                      <Folder className="w-5 h-5 text-yellow-400 flex-shrink-0" />
                      <span className="text-sm text-white truncate">{folder.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Files Table */}
            {filesData && filesData.items.length > 0 ? (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-medium text-gray-500 uppercase">
                    文件 ({filesData.total})
                  </h3>
                  <button
                    onClick={selectAll}
                    className="text-xs text-gray-500 hover:text-gray-300"
                  >
                    {selectedFileIds.size === filesData.items.length ? '取消全选' : '全选'}
                  </button>
                </div>

                <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase">
                        <th className="w-10 px-3 py-2"></th>
                        <th className="px-3 py-2 text-left">名称</th>
                        <th className="px-3 py-2 text-left w-24">大小</th>
                        <th className="px-3 py-2 text-left w-28">更新时间</th>
                        <th className="px-3 py-2 text-left w-20">状态</th>
                        <th className="px-3 py-2 text-left w-32">标签</th>
                        <th className="w-10 px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800/50">
                      {filesData.items.map(file => (
                        <tr
                          key={file.id}
                          className={`hover:bg-gray-800/30 transition-colors ${
                            selectedFileIds.has(file.id) ? 'bg-blue-900/10' : ''
                          }`}
                        >
                          <td className="px-3 py-2">
                            <button onClick={() => toggleFileSelection(file.id)}>
                              {selectedFileIds.has(file.id) ? (
                                <CheckSquare className="w-4 h-4 text-blue-400" />
                              ) : (
                                <Square className="w-4 h-4 text-gray-600" />
                              )}
                            </button>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <FileTypeIcon mimeType={file.mime_type} />
                              <span className="text-sm text-white truncate max-w-xs">
                                {file.display_name}
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-xs text-gray-400">
                            {formatFileSize(file.file_size)}
                          </td>
                          <td className="px-3 py-2 text-xs text-gray-400">
                            {formatDate(file.updated_at)}
                          </td>
                          <td className="px-3 py-2">
                            <IndexStatusBadge status={file.index_status} />
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex gap-1 flex-wrap">
                              {file.tags.slice(0, 2).map(tag => (
                                <span key={tag} className="px-1.5 py-0.5 bg-gray-800 text-gray-400 rounded text-[10px]">
                                  {tag}
                                </span>
                              ))}
                              {file.tags.length > 2 && (
                                <span className="text-[10px] text-gray-500">+{file.tags.length - 2}</span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <button
                              onClick={() => handleToggleStar(file)}
                              className="text-gray-600 hover:text-yellow-400 transition-colors"
                            >
                              <Star className={`w-4 h-4 ${file.is_starred ? 'fill-yellow-400 text-yellow-400' : ''}`} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination info */}
                {filesData.hasMore && (
                  <div className="mt-3 text-center">
                    <span className="text-xs text-gray-500">
                      显示 {filesData.items.length} / {filesData.total} 个文件
                    </span>
                  </div>
                )}
              </div>
            ) : folders.length === 0 ? (
              <div className="text-center py-16">
                <FileText className="w-12 h-12 text-gray-700 mx-auto mb-3" />
                <p className="text-gray-500 text-sm">此文件夹为空</p>
                <p className="text-gray-600 text-xs mt-1">上传文件或创建子文件夹</p>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* Create Knowledge Base Dialog */}
      {showCreateKb && (
        <Dialog title="新建知识库" onClose={() => setShowCreateKb(false)}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-gray-300 mb-1">名称</label>
              <input
                type="text"
                value={newKbName}
                onChange={(e) => setNewKbName(e.target.value)}
                placeholder="例如：销售资料库"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:border-blue-500 outline-none"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm text-gray-300 mb-1">描述（可选）</label>
              <input
                type="text"
                value={newKbDescription}
                onChange={(e) => setNewKbDescription(e.target.value)}
                placeholder="简要描述知识库用途"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:border-blue-500 outline-none"
              />
            </div>
            <div className="flex gap-2 pt-2">
              <button
                onClick={handleCreateKb}
                disabled={!newKbName.trim()}
                className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 disabled:cursor-not-allowed rounded-lg text-white text-sm"
              >
                创建
              </button>
              <button
                onClick={() => setShowCreateKb(false)}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-white text-sm"
              >
                取消
              </button>
            </div>
          </div>
        </Dialog>
      )}

      {/* Create Folder Dialog */}
      {showCreateFolder && (
        <Dialog title="新建文件夹" onClose={() => setShowCreateFolder(false)}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-gray-300 mb-1">文件夹名称</label>
              <input
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="输入文件夹名称"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:border-blue-500 outline-none"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder() }}
              />
            </div>
            <div className="flex gap-2 pt-2">
              <button
                onClick={handleCreateFolder}
                disabled={!newFolderName.trim()}
                className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 disabled:cursor-not-allowed rounded-lg text-white text-sm"
              >
                创建
              </button>
              <button
                onClick={() => setShowCreateFolder(false)}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-white text-sm"
              >
                取消
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  )
}

// ============================================================================
// Sub-components
// ============================================================================

function EmptyState({ onCreateKb }: { onCreateKb: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-64 gap-4">
      <Database className="w-16 h-16 text-gray-700" />
      <div className="text-center">
        <p className="text-gray-400 text-sm">还没有知识库</p>
        <p className="text-gray-600 text-xs mt-1">创建一个知识库来管理您的文档和资料</p>
      </div>
      <button
        onClick={onCreateKb}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white text-sm flex items-center gap-2"
      >
        <Plus className="w-4 h-4" /> 创建知识库
      </button>
    </div>
  )
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-800 rounded-lg p-6 w-full max-w-md mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-white mb-4">{title}</h2>
        {children}
      </div>
    </div>
  )
}
