/**
 * Test Widget Component
 * 
 * A floating chat window that simulates the customer-facing widget.
 * Calls the real Widget API to test AI responses in real-time.
 * Shows AI decision trail alongside the conversation.
 */

import { useState, useRef, useEffect } from 'react'
import { X, Send, Bot, User, Brain, ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import { restClient } from '@/services/api/restClient'

interface TestWidgetProps {
  scopeId: string
  scopeName: string
  apiKeyPrefix: string
  apiKey?: string
  onClose: () => void
}

interface WidgetMessage {
  id: string
  role: 'customer' | 'ai' | 'system'
  content: string
  timestamp: Date
  metadata?: {
    intent?: { intent: string; confidence: number }
    handoff?: boolean
    decisionTrail?: string[]
  }
}

interface WidgetSession {
  conversationId: string
  sessionId: string
  customerId: string | null
}

export function TestWidget({ scopeId, scopeName, apiKeyPrefix, apiKey, onClose }: TestWidgetProps) {
  const [messages, setMessages] = useState<WidgetMessage[]>([])
  const [input, setInput] = useState('')
  const [session, setSession] = useState<WidgetSession | null>(null)
  const [sending, setSending] = useState(false)
  const [initializing, setInitializing] = useState(true)
  const [showDecisionTrail, setShowDecisionTrail] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Initialize widget session
  useEffect(() => {
    initSession()
  }, [])

  const initSession = async () => {
    setInitializing(true)
    try {
      // Use the internal support API to create a session (since we may not have the raw API key)
      const result = await restClient.post<{ conversation: { id: string }; sessionId: string; customerId: string | null }>(
        '/api/support/conversations',
        {
          customerName: 'Test Customer',
          customerEmail: 'test@example.com',
          message: '(session initialized)',
          channelType: 'web_widget',
          priority: 'medium',
          businessScopeId: scopeId,
        }
      )

      setSession({
        conversationId: result.conversation.id,
        sessionId: result.sessionId,
        customerId: result.customerId,
      })

      // Add welcome message
      setMessages([{
        id: 'welcome',
        role: 'ai',
        content: `Hi! I'm the AI assistant for ${scopeName}. How can I help you today?`,
        timestamp: new Date(),
      }])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initialize widget session')
    } finally {
      setInitializing(false)
    }
  }

  const handleSend = async () => {
    if (!input.trim() || !session || sending) return

    const userMessage: WidgetMessage = {
      id: `user-${Date.now()}`,
      role: 'customer',
      content: input.trim(),
      timestamp: new Date(),
    }

    setMessages(prev => [...prev, userMessage])
    setInput('')
    setSending(true)

    try {
      // Call the internal support API to send message and get AI response
      const response = await restClient.post<{
        reply: string | null
        handoff: boolean
        intent: { intent: string; confidence: number } | null
        decisionTrail: string[]
        status: string
      }>(`/api/support/conversations/${session.conversationId}/widget-message`, {
        content: userMessage.content,
        sessionId: session.sessionId,
      })

      const aiMessage: WidgetMessage = {
        id: `ai-${Date.now()}`,
        role: response.handoff ? 'system' : 'ai',
        content: response.reply ?? 'A support agent will be with you shortly.',
        timestamp: new Date(),
        metadata: {
          intent: response.intent ?? undefined,
          handoff: response.handoff,
          decisionTrail: response.decisionTrail,
        },
      }

      setMessages(prev => [...prev, aiMessage])
    } catch (err) {
      const errorMessage: WidgetMessage = {
        id: `error-${Date.now()}`,
        role: 'system',
        content: 'Sorry, something went wrong. Please try again.',
        timestamp: new Date(),
      }
      setMessages(prev => [...prev, errorMessage])
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed bottom-6 right-6 w-[380px] h-[560px] bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl flex flex-col z-50 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-blue-600 to-purple-600">
        <div className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-white" />
          <div>
            <h4 className="text-sm font-semibold text-white">Test Widget</h4>
            <p className="text-[10px] text-white/70">{scopeName}</p>
          </div>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-white/20 rounded transition-colors">
          <X className="w-4 h-4 text-white" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {initializing ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Loader2 className="w-6 h-6 text-blue-400 animate-spin mx-auto mb-2" />
              <p className="text-xs text-gray-500">Initializing session...</p>
            </div>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-xs text-red-400">{error}</p>
              <button onClick={initSession} className="mt-2 text-xs text-blue-400 hover:text-blue-300">Retry</button>
            </div>
          </div>
        ) : (
          messages.map(msg => (
            <div key={msg.id}>
              <div className={`flex ${msg.role === 'customer' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] px-3 py-2 rounded-xl text-sm ${
                  msg.role === 'customer'
                    ? 'bg-blue-600 text-white rounded-br-sm'
                    : msg.role === 'system'
                    ? 'bg-yellow-600/20 text-yellow-300 border border-yellow-600/30 rounded-bl-sm'
                    : 'bg-gray-800 text-gray-200 rounded-bl-sm'
                }`}>
                  {msg.role !== 'customer' && (
                    <div className="flex items-center gap-1 mb-1">
                      {msg.role === 'ai' ? <Bot className="w-3 h-3 text-blue-400" /> : null}
                      <span className="text-[10px] text-gray-500">
                        {msg.role === 'ai' ? 'AI Assistant' : 'System'}
                      </span>
                    </div>
                  )}
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                </div>
              </div>

              {/* Decision Trail (expandable) */}
              {msg.metadata?.decisionTrail && msg.metadata.decisionTrail.length > 0 && (
                <div className="mt-1 ml-2">
                  <button
                    onClick={() => setShowDecisionTrail(showDecisionTrail === msg.id ? null : msg.id)}
                    className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-400"
                  >
                    <Brain className="w-3 h-3" />
                    AI Decision
                    {msg.metadata.intent && (
                      <span className="px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded text-[9px]">
                        {msg.metadata.intent.intent} ({(msg.metadata.intent.confidence * 100).toFixed(0)}%)
                      </span>
                    )}
                    {showDecisionTrail === msg.id ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                  {showDecisionTrail === msg.id && (
                    <div className="mt-1 p-2 bg-gray-800/50 rounded-lg border border-gray-700/50">
                      {msg.metadata.decisionTrail.map((step, i) => (
                        <div key={i} className="flex items-start gap-1.5 text-[10px] text-gray-400 py-0.5">
                          <span className="text-gray-600 flex-shrink-0">{i + 1}.</span>
                          <span>{step}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-gray-800">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
            placeholder="Type a message as a customer..."
            disabled={!session || sending || initializing}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || !session || sending}
            className="p-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-xl transition-colors"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  )
}
