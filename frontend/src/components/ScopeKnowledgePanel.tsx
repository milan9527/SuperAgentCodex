/**
 * ScopeKnowledgePanel — Manage knowledge base bindings for a business scope.
 *
 * Replaces the old DocGroupsPanel approach. Instead of managing document groups
 * directly within a scope, users bind independent knowledge bases to the scope.
 * Knowledge bases are managed separately in the Knowledge Base Drive page.
 */

import { useState, useEffect, useCallback } from 'react'
import { Database, Plus, Trash2, Loader2, ExternalLink } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { KnowledgeBaseAPI, type KnowledgeBase, type ScopeKnowledgeBinding } from '@/services/knowledgeBaseService'
import { useToast } from '@/components'

interface ScopeKnowledgePanelProps {
  scopeId: string
}

export function ScopeKnowledgePanel({ scopeId }: ScopeKnowledgePanelProps) {
  const navigate = useNavigate()
  const { success, error: showError } = useToast()

  const [bindings, setBindings] = useState<ScopeKnowledgeBinding[]>([])
  const [allKbs, setAllKbs] = useState<KnowledgeBase[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showPicker, setShowPicker] = useState(false)

  const loadBindings = useCallback(async () => {
    setIsLoading(true)
    try {
      const data = await KnowledgeBaseAPI.getScopeBindings(scopeId)
      setBindings(data)
    } catch (err) {
      console.error('Failed to load knowledge base bindings:', err)
    } finally {
      setIsLoading(false)
    }
  }, [scopeId])

  const loadAllKbs = useCallback(async () => {
    try {
      const kbs = await KnowledgeBaseAPI.list()
      setAllKbs(kbs)
    } catch (err) {
      console.error('Failed to load knowledge bases:', err)
    }
  }, [])

  useEffect(() => { loadBindings() }, [loadBindings])

  const boundIds = new Set(bindings.map(b => b.knowledge_base_id))
  const availableKbs = allKbs.filter(kb => !boundIds.has(kb.id))

  const handleBind = async (kbId: string) => {
    try {
      await KnowledgeBaseAPI.bindToScope(scopeId, kbId)
      success('知识库已绑定')
      setShowPicker(false)
      loadBindings()
    } catch (err) {
      showError(err instanceof Error ? err.message : '绑定失败')
    }
  }

  const handleUnbind = async (kbId: string) => {
    try {
      await KnowledgeBaseAPI.unbindFromScope(scopeId, kbId)
      success('知识库已解绑')
      loadBindings()
    } catch (err) {
      showError(err instanceof Error ? err.message : '解绑失败')
    }
  }

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B'
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-blue-400" />
          <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">知识库</h3>
          <span className="text-[10px] text-gray-600">{bindings.length} 个已绑定</span>
        </div>
        <button
          onClick={() => { setShowPicker(!showPicker); loadAllKbs() }}
          className="flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors"
        >
          <Plus className="w-3 h-3" /> 绑定知识库
        </button>
      </div>

      {/* Picker */}
      {showPicker && (
        <div className="mb-3 border border-gray-700 rounded-lg bg-gray-800/50 max-h-48 overflow-y-auto">
          {availableKbs.length === 0 ? (
            <div className="p-3 text-center">
              <p className="text-xs text-gray-400">没有可绑定的知识库</p>
              <button
                onClick={() => navigate('/knowledge')}
                className="mt-2 text-[10px] text-blue-400 hover:text-blue-300 flex items-center gap-1 mx-auto"
              >
                <Plus className="w-3 h-3" /> 去创建知识库
              </button>
            </div>
          ) : (
            availableKbs.map(kb => (
              <button
                key={kb.id}
                onClick={() => handleBind(kb.id)}
                className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-700/50 text-left border-b border-gray-700/50 last:border-0"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm">{kb.icon || '📚'}</span>
                  <div>
                    <p className="text-xs text-white">{kb.name}</p>
                    {kb.description && <p className="text-[10px] text-gray-400 truncate max-w-[200px]">{kb.description}</p>}
                  </div>
                </div>
                <span className="text-[10px] text-gray-500">{kb.document_count} 个文件</span>
              </button>
            ))
          )}
        </div>
      )}

      {/* Bound knowledge bases */}
      {isLoading ? (
        <div className="py-4 text-center">
          <Loader2 className="w-4 h-4 text-blue-500 animate-spin mx-auto" />
        </div>
      ) : bindings.length === 0 ? (
        <div className="py-4 text-center">
          <p className="text-xs text-gray-500">未绑定知识库</p>
          <p className="text-[10px] text-gray-600 mt-1">绑定后，Agent 可以检索知识库中的所有文档</p>
        </div>
      ) : (
        <div className="space-y-2">
          {bindings.map(binding => {
            const kb = binding.knowledge_base
            return (
              <div
                key={binding.id}
                className="flex items-center justify-between px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm flex-shrink-0">{kb.icon || '📚'}</span>
                  <div className="min-w-0">
                    <p className="text-xs text-white font-medium truncate">{kb.name}</p>
                    <p className="text-[10px] text-gray-500">
                      {kb.document_count} 个文件 · {formatSize(Number(kb.total_size))}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => navigate('/knowledge')}
                    className="p-1 text-gray-600 hover:text-blue-400 transition-colors"
                    title="管理知识库"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleUnbind(kb.id)}
                    className="p-1 text-gray-600 hover:text-red-400 transition-colors"
                    title="解绑知识库"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Hint */}
      <p className="mt-3 text-[10px] text-gray-600 leading-relaxed">
        💡 绑定后，该 Scope 下的 Agent 可以检索知识库中的所有文档。知识库更新时无需重新配置。
      </p>
    </div>
  )
}
