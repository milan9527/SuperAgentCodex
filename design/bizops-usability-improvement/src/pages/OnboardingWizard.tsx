import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Send, Bot, User, Sparkles, Check,
  TrendingUp, Users, Headphones, Zap, Clock, RotateCcw
} from 'lucide-react'

interface Message {
  id: string
  role: 'assistant' | 'user'
  content: string
  options?: { label: string; value: string; icon?: any }[]
  selectedOption?: string
  deployResult?: {
    scope: string
    agents: string[]
    workflows: { name: string; schedule?: string }[]
  }
}

const initialMessages: Message[] = [
  {
    id: '1',
    role: 'assistant',
    content: '你好！我是 Super Agent 配置助手。告诉我你想解决什么业务问题，我来帮你搭建完整的 AI 工作流。\n\n你可以选择一个场景，或者直接描述你的需求：',
    options: [
      { label: '品牌增长与营销', value: 'marketing', icon: TrendingUp },
      { label: '客户服务自动化', value: 'support', icon: Headphones },
      { label: '人才招聘管理', value: 'hr', icon: Users },
      { label: '其他场景', value: 'other', icon: Sparkles },
    ],
  },
]

const conversationFlow: Record<string, Message[]> = {
  marketing: [
    { id: 'a1', role: 'assistant', content: '品牌增长是个好方向！我需要了解一些基本信息来为你定制方案。\n\n你的品牌域名是什么？' },
  ],
  domain_received: [
    { id: 'a2', role: 'assistant', content: '收到。你主要想在哪些平台上做品牌增长？可以多选：',
      options: [
        { label: 'X / Twitter', value: 'twitter' },
        { label: 'Reddit', value: 'reddit' },
        { label: 'YouTube', value: 'youtube' },
        { label: '小红书', value: 'xiaohongshu' },
        { label: 'LinkedIn', value: 'linkedin' },
      ],
    },
  ],
  platforms_received: [
    { id: 'a3', role: 'assistant', content: '明白了。你希望系统多久推送一次增长机会？',
      options: [
        { label: '每天早上 8:00', value: 'daily_8', icon: Clock },
        { label: '每天早上 + 下午各一次', value: 'twice_daily', icon: Clock },
        { label: '每周一次汇总', value: 'weekly', icon: Clock },
      ],
    },
  ],
  schedule_received: [
    { id: 'a4', role: 'assistant', content: '最后一个问题：你有主要的竞争对手需要监控吗？如果有，请告诉我他们的域名或品牌名（没有的话可以跳过）。' },
  ],
  final: [
    { id: 'a5', role: 'assistant', content: '完美！根据你的需求，我为你规划了以下方案：',
      deployResult: {
        scope: '品牌增长',
        agents: ['品牌策略师', '社交监听员', '内容创作者', 'SEO/GEO 专家', '红人经理'],
        workflows: [
          { name: '品牌诊断分析', schedule: '手动触发' },
          { name: '每日增长机会扫描', schedule: '每天 08:00' },
          { name: '周度品牌健康报告', schedule: '每周一 09:00' },
          { name: '红人发现与评估', schedule: '手动触发' },
        ],
      },
    },
  ],
}

export default function OnboardingWizard() {
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [inputValue, setInputValue] = useState('')
  const [currentStep, setCurrentStep] = useState(0)
  const [isDeploying, setIsDeploying] = useState(false)
  const [isDeployed, setIsDeployed] = useState(false)
  const [isTyping, setIsTyping] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => { scrollToBottom() }, [messages, isTyping])

  const addAssistantMessages = (msgs: Message[]) => {
    setIsTyping(true)
    setTimeout(() => {
      setIsTyping(false)
      setMessages(prev => [...prev, ...msgs])
    }, 1200)
  }

  const handleOptionSelect = (option: { label: string; value: string }) => {
    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: option.label }
    setMessages(prev => [...prev, userMsg])

    if (currentStep === 0) {
      setCurrentStep(1)
      addAssistantMessages(conversationFlow.marketing)
    } else if (currentStep === 2) {
      setCurrentStep(3)
      addAssistantMessages(conversationFlow.platforms_received)
    } else if (currentStep === 3) {
      setCurrentStep(4)
      addAssistantMessages(conversationFlow.schedule_received)
    }
  }

  const handleSend = () => {
    if (!inputValue.trim()) return
    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: inputValue }
    setMessages(prev => [...prev, userMsg])
    setInputValue('')

    if (currentStep === 1) {
      setCurrentStep(2)
      addAssistantMessages(conversationFlow.domain_received)
    } else if (currentStep === 2) {
      setCurrentStep(3)
      addAssistantMessages(conversationFlow.platforms_received)
    } else if (currentStep === 3) {
      setCurrentStep(4)
      addAssistantMessages(conversationFlow.schedule_received)
    } else if (currentStep === 4) {
      setCurrentStep(5)
      addAssistantMessages(conversationFlow.final)
    }
  }

  const handleDeploy = () => {
    setIsDeploying(true)
    setTimeout(() => {
      setIsDeploying(false)
      setIsDeployed(true)
      const doneMsg: Message = {
        id: 'done',
        role: 'assistant',
        content: '✅ 部署完成！所有 Agent 和工作流已就绪。\n\n• 品牌诊断分析 — 你可以现在手动触发试试\n• 每日增长机会扫描 — 明天 8:00 自动执行首次扫描\n• 周度品牌健康报告 — 下周一 9:00 生成首份报告\n\n需要我调整什么吗？',
      }
      setMessages(prev => [...prev, doneMsg])
    }, 3000)
  }

  const handleReset = () => {
    setMessages(initialMessages)
    setCurrentStep(0)
    setIsDeploying(false)
    setIsDeployed(false)
    setInputValue('')
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white mb-1">引导式配置向导</h1>
          <p className="text-gray-400 text-sm">通过对话完成业务配置，无需理解平台概念</p>
        </div>
        <button onClick={handleReset} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-gray-400 text-sm hover:bg-gray-800 hover:text-gray-200 transition-colors">
          <RotateCcw size={14} />
          重新开始
        </button>
      </div>

      {/* Chat Container */}
      <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
        {/* Progress Bar */}
        <div className="px-6 py-3 border-b border-gray-700 bg-gray-800/50">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span>配置进度</span>
            <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
              <motion.div
                className="h-full bg-blue-500 rounded-full"
                initial={{ width: '0%' }}
                animate={{ width: `${Math.min(currentStep / 5 * 100, 100)}%` }}
                transition={{ duration: 0.5 }}
              />
            </div>
            <span>{Math.min(currentStep, 5)}/5</span>
          </div>
        </div>

        {/* Messages */}
        <div className="h-[520px] overflow-y-auto px-6 py-5 space-y-5">
          <AnimatePresence>
            {messages.map(msg => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
                className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
              >
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  msg.role === 'assistant' ? 'bg-blue-500/20' : 'bg-gray-700'
                }`}>
                  {msg.role === 'assistant' ? <Bot size={16} className="text-blue-400" /> : <User size={16} className="text-gray-400" />}
                </div>

                <div className={`max-w-[80%] ${msg.role === 'user' ? 'text-right' : ''}`}>
                  <div className={`inline-block px-4 py-3 rounded-2xl text-sm leading-relaxed ${
                    msg.role === 'assistant'
                      ? 'bg-gray-700 text-gray-200 rounded-tl-md'
                      : 'bg-blue-600 text-white rounded-tr-md'
                  }`}>
                    <p className="whitespace-pre-line">{msg.content}</p>
                  </div>

                  {msg.options && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {msg.options.map(opt => (
                        <button
                          key={opt.value}
                          onClick={() => handleOptionSelect(opt)}
                          className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-gray-900 border border-gray-700
                                     text-sm text-gray-300 font-medium hover:border-blue-500/50 hover:bg-blue-500/10
                                     transition-colors"
                        >
                          {opt.icon && <opt.icon size={14} className="text-blue-400" />}
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  )}

                  {msg.deployResult && (
                    <div className="mt-4 bg-gray-900 rounded-xl border border-gray-700 p-4 text-left">
                      <div className="flex items-center gap-2 mb-3">
                        <Sparkles size={16} className="text-blue-400" />
                        <span className="text-sm font-semibold text-white">方案：{msg.deployResult.scope}</span>
                      </div>
                      <div className="space-y-3">
                        <div>
                          <div className="text-xs text-gray-500 mb-1.5">AI Agent 团队</div>
                          <div className="flex flex-wrap gap-1.5">
                            {msg.deployResult.agents.map(a => (
                              <span key={a} className="px-2.5 py-1 bg-blue-500/15 text-blue-400 text-xs rounded-lg font-medium">
                                {a}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-gray-500 mb-1.5">自动化工作流</div>
                          <div className="space-y-1.5">
                            {msg.deployResult.workflows.map(wf => (
                              <div key={wf.name} className="flex items-center justify-between text-xs">
                                <span className="text-gray-300 font-medium">{wf.name}</span>
                                <span className="text-gray-500 flex items-center gap-1"><Clock size={10} />{wf.schedule}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                      {!isDeployed && (
                        <button
                          onClick={handleDeploy}
                          disabled={isDeploying}
                          className="mt-4 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 disabled:opacity-60 transition-colors"
                        >
                          {isDeploying ? (
                            <><motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}><Zap size={16} /></motion.div>正在部署...</>
                          ) : (
                            <><Check size={16} />确认并一键部署</>
                          )}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {isTyping && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center">
                <Bot size={16} className="text-blue-400" />
              </div>
              <div className="px-4 py-3 rounded-2xl rounded-tl-md bg-gray-700">
                <div className="flex gap-1.5">
                  {[0, 300, 600].map(delay => (
                    <div key={delay} className="w-2 h-2 rounded-full bg-gray-500" style={{ animation: `pulse-dot 2s ease-in-out infinite ${delay}ms` }} />
                  ))}
                </div>
              </div>
            </motion.div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="px-6 py-4 border-t border-gray-700">
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSend()}
              placeholder="输入你的回答..."
              className="flex-1 px-4 py-2.5 rounded-xl border border-gray-700 bg-gray-900 text-sm text-white placeholder-gray-500
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <button
              onClick={handleSend}
              disabled={!inputValue.trim()}
              className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center
                         hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
