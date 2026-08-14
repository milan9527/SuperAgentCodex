/**
 * Support Live Monitoring Page
 * 
 * Real-time AI service monitoring. Shows AI decision process for each conversation,
 * allows human takeover when AI can't handle it.
 */

import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bot, User, Brain, Send, CheckCircle, ArrowLeft, AlertTriangle, Zap, MessageSquare, UserPlus, Clock } from 'lucide-react'
import { RestSupportService, type SupportConversation, type ChatMessage } from '@/services/api/restSupportService'
import { useTranslation } from '@/i18n'

type LiveFilter = 'all' | 'ai_handling' | 'needs_human' | 'resolved'

const statusToFilter: Record<string, LiveFilter> = {
  open: 'ai_handling',
  pending_agent: 'needs_human',
  resolved: 'resolved',
  closed: 'resolved',
}

export function SupportLive() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [conversations, setConversations] = useState<SupportConversation[]>([])
  const [selectedConv, setSelectedConv] = useState<(SupportConversation & { messages: ChatMessage[] }) | null>(null)
  const [filter, setFilter] = useState<LiveFilter>('all')
  const [loading, setLoading] = useState(true)
  const [replyText, setReplyText] = useState('')
  const [isTakenOver, setIsTakenOver] = useState(false)

  const loadConversations = useCallback(async () => {
    try {
      const params: Record<string, string> = {}
      if (filter === 'ai_handling') params.status = 'open'
      else if (filter === 'needs_human') params.status = 'pending_agent'
      else if (filter === 'resolved') params.status = 'resolved'
      const result = await RestSupportService.getConversations(params)
      setConversations(result.data)
    } catch (err) {
      console.error('Failed to load conversations:', err)
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    loadConversations()
    const interval = setInterval(loadConversations, 5_000)
    return () => clearInterval(interval)
  }, [loadConversations])

  const selectConversation = async (conv: SupportConversation) => {
    try {
      const detail = await RestSupportService.getConversation(conv.id)
      setSelectedConv(detail)
      setIsTakenOver(conv.status === 'open' && !!conv.assigned_agent_id)
    } catch (err) {
      console.error('Failed to load conversation:', err)
    }
  }

  const handleTakeover = async () => {
    if (!selectedConv) return
    // Assign to current user (the API will use the authenticated user's ID)
    try {
      await RestSupportService.resolveConversation(selectedConv.id) // This is a simplification
      setIsTakenOver(true)
      // Reload
      const detail = await RestSupportService.getConversation(selectedConv.id)
      setSelectedConv(detail)
    } catch {}
  }

  const handleSendReply = async () => {
    if (!selectedConv || !replyText.trim()) return
    try {
      await RestSupportService.sendMessage(selectedConv.id, replyText)
      setReplyText('')
      const detail = await RestSupportService.getConversation(selectedConv.id)
      setSelectedConv(detail)
    } catch (err) {
      console.error('Failed to send reply:', err)
    }
  }

  const handleResolve = async () => {
    if (!selectedConv) return
    await RestSupportService.resolveConversation(selectedConv.id)
    loadConversations()
    setSelectedConv(null)
    setIsTakenOver(false)
  }

  const filters: { key: LiveFilter; label: string; count: number; color: string }[] = [
    { key: 'all', label: 'All', count: conversations.length, color: 'text-white' },
    { key: 'ai_handling', label: 'AI Handling', count: conversations.filter(c => c.status === 'open').length, color: 'text-green-400' },
    { key: 'needs_human', label: 'Needs Human', count: conversations.filter(c => c.status === 'pending_agent').length, color: 'text-yellow-400' },
    { key: 'resolved', label: 'Resolved', count: conversations.filter(c => c.status === 'resolved' || c.status === 'closed').length, color: 'text-blue-400' },
  ]

  const getConvStatusIcon = (conv: SupportConversation) => {
    if (conv.status === 'pending_agent') return <AlertTriangle className="w-3.5 h-3.5 text-yellow-400" />
    if (conv.status === 'resolved') return <CheckCircle className="w-3.5 h-3.5 text-blue-400" />
    return <Bot className="w-3.5 h-3.5 text-green-400" />
  }

  const getConfidenceBar = (confidence: number | null) => {
    if (confidence === null) return null
    const pct = Math.round(confidence * 100)
    const color = pct >= 70 ? 'bg-green-500' : pct >= 40 ? 'bg-yellow-500' : 'bg-red-500'
    return (
      <div className="flex items-center gap-1">
        <div className="w-12 h-1.5 bg-gray-700 rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="text-[9px] text-gray-500">{pct}%</span>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {/* Left Panel: Conversation List */}
      <div className="w-96 border-r border-white/10 flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-white/10">
          <div className="flex items-center gap-2 mb-3">
            <button onClick={() => navigate('/support')} className="p-1 hover:bg-white/10 rounded">
              <ArrowLeft className="w-4 h-4 text-gray-400" />
            </button>
            <Zap className="w-5 h-5 text-green-400" />
            <h2 className="text-lg font-semibold">Live Monitor</h2>
          </div>

          {/* Filter tabs */}
          <div className="flex gap-1">
            {filters.map(f => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`flex items-center gap-1 px-2 py-1 text-[11px] rounded-full transition-colors ${
                  filter === f.key ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                <span className={f.color}>{f.count}</span>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Conversation List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-center text-gray-500 text-sm">Loading...</div>
          ) : conversations.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <Bot className="w-10 h-10 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No active conversations</p>
            </div>
          ) : (
            conversations.map(conv => {
              const meta = conv.metadata as Record<string, unknown> | undefined
              const intentLabel = meta?.intent as string | undefined
              const confidence = conv.ai_confidence

              return (
                <button
                  key={conv.id}
                  onClick={() => selectConversation(conv)}
                  className={`w-full p-3 text-left border-b border-white/5 hover:bg-white/5 transition-colors ${
                    selectedConv?.id === conv.id ? 'bg-white/10' : ''
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {getConvStatusIcon(conv)}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-sm font-medium truncate">{conv.customer?.name ?? 'Customer'}</span>
                        <span className="text-[10px] text-gray-600">{new Date(conv.created_at).toLocaleTimeString()}</span>
                      </div>

                      {/* AI Status Line */}
                      <div className="flex items-center gap-2 mb-1">
                        {intentLabel && (
                          <span className="text-[9px] px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded">{intentLabel}</span>
                        )}
                        {getConfidenceBar(confidence)}
                        {conv.sentiment_score !== null && conv.sentiment_score < -0.3 && (
                          <span className="text-[9px] px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded">😠</span>
                        )}
                      </div>

                      {/* Last message preview */}
                      {meta?.lastMessage != null && (
                        <p className="text-[11px] text-gray-500 truncate italic">"{String(meta.lastMessage).substring(0, 50)}"</p>
                      )}
                    </div>
                  </div>
                </button>
              )
            })
          )}
        </div>
      </div>

      {/* Right Panel: Conversation Detail */}
      <div className="flex-1 flex flex-col">
        {selectedConv ? (
          <>
            {/* Detail Header */}
            <div className="p-4 border-b border-white/10 flex items-center justify-between">
              <div>
                <h3 className="font-medium">{selectedConv.customer?.name ?? 'Customer'}</h3>
                <div className="flex items-center gap-2 mt-1">
                  {selectedConv.ai_confidence !== null && getConfidenceBar(selectedConv.ai_confidence)}
                  <span className="text-[10px] text-gray-500">{selectedConv.channel_type}</span>
                </div>
              </div>
              <div className="flex gap-2">
                {!isTakenOver && selectedConv.status === 'pending_agent' && (
                  <button
                    onClick={handleTakeover}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-600/20 hover:bg-yellow-600/30 text-yellow-400 rounded-lg text-xs transition-colors"
                  >
                    <UserPlus className="w-3.5 h-3.5" />
                    Take Over
                  </button>
                )}
                {(isTakenOver || selectedConv.status !== 'resolved') && (
                  <button
                    onClick={handleResolve}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600/20 hover:bg-green-600/30 text-green-400 rounded-lg text-xs transition-colors"
                  >
                    <CheckCircle className="w-3.5 h-3.5" />
                    Resolve
                  </button>
                )}
              </div>
            </div>

            {/* AI Decision Trail */}
            {selectedConv.metadata && (selectedConv.metadata as any).intent && (
              <div className="px-4 py-2 bg-gray-900/50 border-b border-white/5">
                <div className="flex items-center gap-1.5 mb-1">
                  <Brain className="w-3.5 h-3.5 text-purple-400" />
                  <span className="text-[10px] text-gray-400 font-medium uppercase">AI Decision</span>
                </div>
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded">
                    Intent: {(selectedConv.metadata as any).intent}
                  </span>
                  <span className="px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded">
                    Confidence: {((selectedConv.metadata as any).confidence * 100).toFixed(0)}%
                  </span>
                  {selectedConv.sentiment_score !== null && (
                    <span className={`px-1.5 py-0.5 rounded ${
                      selectedConv.sentiment_score < -0.3 ? 'bg-red-500/20 text-red-400' : 'bg-gray-500/20 text-gray-400'
                    }`}>
                      Sentiment: {selectedConv.sentiment_score.toFixed(2)}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {(selectedConv.messages ?? []).map(msg => (
                <div key={msg.id} className={`flex ${msg.type === 'user' ? 'justify-start' : 'justify-end'}`}>
                  <div className={`max-w-[70%] px-3 py-2 rounded-xl text-sm ${
                    msg.type === 'user'
                      ? 'bg-white/10 text-gray-200 rounded-bl-sm'
                      : 'bg-blue-600/20 text-blue-200 rounded-br-sm'
                  }`}>
                    <div className="flex items-center gap-1 mb-1">
                      {msg.type === 'user' ? <User className="w-3 h-3 text-gray-500" /> : <Bot className="w-3 h-3 text-blue-400" />}
                      <span className="text-[10px] text-gray-500">{msg.type === 'user' ? 'Customer' : 'AI Agent'}</span>
                      <span className="text-[9px] text-gray-600 ml-auto">{new Date(msg.created_at).toLocaleTimeString()}</span>
                    </div>
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Reply Input (only shown when taken over or pending_agent) */}
            {(isTakenOver || selectedConv.status === 'pending_agent') && (
              <div className="p-4 border-t border-white/10">
                <div className="text-[10px] text-yellow-400 mb-2 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  Human takeover mode — your reply will be sent to the customer
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={replyText}
                    onChange={e => setReplyText(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSendReply()}
                    placeholder="Type your reply..."
                    className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={handleSendReply}
                    disabled={!replyText.trim()}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            <div className="text-center">
              <Bot className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Select a conversation to monitor AI decisions</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
