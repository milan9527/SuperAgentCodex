import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Upload, FileText, Bot, Zap, Globe, Clock, Check, X,
  ChevronDown, ChevronRight, Plus, Play, AlertCircle, Sparkles, GripVertical
} from 'lucide-react'

type BlueprintStatus = 'idle' | 'uploading' | 'analyzing' | 'ready' | 'deploying' | 'deployed'

interface BlueprintAgent {
  id: string
  name: string
  role: string
  skills: string[]
}

interface BlueprintWorkflow {
  id: string
  name: string
  trigger: string
  schedule?: string
  nodes: string[]
}

interface BlueprintConnector {
  id: string
  name: string
  status: 'required' | 'optional' | 'connected'
  authType: string
}

const mockBlueprint = {
  scopeName: '品牌增长',
  description: '基于品牌域名的全方位增长策略，覆盖社交监听、内容创作、SEO/GEO 优化和红人营销',
  agents: [
    { id: 'a1', name: '品牌策略师', role: '负责品牌定位分析、目标受众画像和竞争格局研判', skills: ['品牌诊断', '竞品分析', '受众画像', '话题集群生成'] },
    { id: 'a2', name: '社交监听员', role: '实时监控目标平台的品牌相关讨论，识别增长机会和风险信号', skills: ['社交数据抓取', '情感分析', '趋势识别', '机会评分'] },
    { id: 'a3', name: '内容创作者', role: '基于品牌调性和热点话题，生成多平台适配的营销内容', skills: ['内容策划', '文案生成', '多平台适配', 'A/B 标题测试'] },
    { id: 'a4', name: 'SEO/GEO 专家', role: '优化品牌在 Google 搜索和 AI 搜索引擎中的可见性', skills: ['SEO 审计', '关键词研究', 'AI 搜索优化', '结构化数据'] },
    { id: 'a5', name: '红人经理', role: '发现和评估适合品牌的 KOL，管理合作关系', skills: ['KOL 发现', '影响力评估', '合作匹配', 'ROI 追踪'] },
  ] as BlueprintAgent[],
  workflows: [
    { id: 'w1', name: '品牌诊断分析', trigger: '手动触发', nodes: ['抓取品牌官网', '分析竞品', '生成受众画像', '输出定位报告'] },
    { id: 'w2', name: '每日增长机会扫描', trigger: '定时触发', schedule: '0 8 * * *', nodes: ['扫描 X/Reddit 讨论', '评分机会价值', '生成行动建议', '推送到 Slack'] },
    { id: 'w3', name: '周度品牌健康报告', trigger: '定时触发', schedule: '0 9 * * 1', nodes: ['汇总周度数据', '分析趋势变化', '对比竞品表现', '生成可视化报告'] },
    { id: 'w4', name: '红人发现与评估', trigger: '手动触发', nodes: ['搜索目标领域 KOL', '评估粉丝质量', '计算合作 ROI', '输出推荐清单'] },
  ] as BlueprintWorkflow[],
  connectors: [
    { id: 'c1', name: 'Twitter/X API', status: 'required', authType: 'OAuth 2.0' },
    { id: 'c2', name: 'Reddit API', status: 'required', authType: 'OAuth 2.0' },
    { id: 'c3', name: 'Google Search Console', status: 'required', authType: 'OAuth 2.0' },
    { id: 'c4', name: 'Slack', status: 'optional', authType: 'OAuth 2.0' },
    { id: 'c5', name: 'YouTube Data API', status: 'optional', authType: 'API Key' },
  ] as BlueprintConnector[],
}

export default function ScopeBlueprint() {
  const [status, setStatus] = useState<BlueprintStatus>('idle')
  const [blueprint] = useState(mockBlueprint)
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set())
  const [expandedWorkflows, setExpandedWorkflows] = useState<Set<string>>(new Set())

  const handleUpload = () => {
    setStatus('uploading')
    setTimeout(() => { setStatus('analyzing'); setTimeout(() => setStatus('ready'), 2500) }, 1500)
  }

  const handleDeploy = () => {
    setStatus('deploying')
    setTimeout(() => setStatus('deployed'), 3000)
  }

  const toggleAgent = (id: string) => {
    setExpandedAgents(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  const toggleWorkflow = (id: string) => {
    setExpandedWorkflows(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-2">业务域蓝图</h1>
        <p className="text-gray-400">上传业务描述文档，AI 自动规划完整的 Scope 配置方案，审阅后一键部署</p>
      </div>

      {/* Upload Area */}
      {status === 'idle' && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="bg-gray-800 rounded-xl border border-gray-700 p-8">
          <div
            onClick={handleUpload}
            className="border-2 border-dashed border-gray-600 rounded-xl p-12 text-center
                       hover:border-blue-500/50 hover:bg-blue-500/5 transition-colors cursor-pointer group"
          >
            <div className="w-16 h-16 rounded-2xl bg-blue-500/20 flex items-center justify-center mx-auto mb-4 group-hover:bg-blue-500/30 transition-colors">
              <Upload size={28} className="text-blue-400" />
            </div>
            <h3 className="text-lg font-semibold text-white mb-2">上传业务描述文档</h3>
            <p className="text-sm text-gray-500 mb-4">支持 PDF、Word、Markdown 或纯文本格式<br />也可以直接粘贴业务需求描述</p>
            <div className="flex items-center justify-center gap-3">
              <span className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium">
                <Upload size={16} /> 选择文件
              </span>
              <span className="text-sm text-gray-500">或拖拽到此处</span>
            </div>
          </div>
          <div className="mt-6 p-4 bg-gray-900 rounded-xl border border-gray-700">
            <div className="flex items-start gap-3">
              <FileText size={18} className="text-gray-500 mt-0.5" />
              <div>
                <p className="text-sm text-gray-400 font-medium mb-1">示例：你可以上传这样的文档</p>
                <p className="text-xs text-gray-500 leading-relaxed">
                  "我们需要一个品牌增长系统：输入品牌域名后自动分析竞品、生成内容策略，每天扫描 X 和 Reddit 上的相关讨论并推送增长机会..."
                </p>
              </div>
            </div>
          </div>
        </motion.div>
      )}

      {/* Analyzing */}
      {(status === 'uploading' || status === 'analyzing') && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="bg-gray-800 rounded-xl border border-gray-700 p-12 flex flex-col items-center">
          <motion.div animate={{ rotate: 360 }} transition={{ duration: 2, repeat: Infinity, ease: 'linear' }} className="w-16 h-16 rounded-2xl bg-blue-500/20 flex items-center justify-center mb-6">
            <Sparkles size={28} className="text-blue-400" />
          </motion.div>
          <h3 className="text-lg font-semibold text-white mb-2">
            {status === 'uploading' ? '正在读取文档...' : '正在分析业务需求并生成蓝图...'}
          </h3>
          <p className="text-sm text-gray-500">{status === 'uploading' ? '解析文档内容' : 'AI 正在规划 Agent 团队、工作流和所需连接器'}</p>
          <div className="mt-6 w-64 h-1.5 bg-gray-700 rounded-full overflow-hidden">
            <motion.div className="h-full bg-blue-500 rounded-full" initial={{ width: '0%' }} animate={{ width: status === 'uploading' ? '40%' : '85%' }} transition={{ duration: 2 }} />
          </div>
        </motion.div>
      )}

      {/* Blueprint Ready */}
      {(status === 'ready' || status === 'deploying' || status === 'deployed') && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
          {/* Header */}
          <div className="bg-gray-800 rounded-xl border border-gray-700 p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-emerald-500/20 flex items-center justify-center">
                  <Sparkles size={24} className="text-emerald-400" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-white">{blueprint.scopeName}</h2>
                  <p className="text-sm text-gray-500">{blueprint.description}</p>
                </div>
              </div>
              {status === 'ready' && (
                <button onClick={handleDeploy} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 transition-colors">
                  <Play size={16} /> 一键部署
                </button>
              )}
              {status === 'deployed' && (
                <div className="flex items-center gap-2 px-4 py-2 bg-emerald-500/20 text-emerald-400 rounded-lg text-sm font-medium">
                  <Check size={16} /> 已部署
                </div>
              )}
            </div>
          </div>

          {status === 'deploying' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="bg-gray-800 rounded-xl border border-gray-700 p-8 flex flex-col items-center">
              <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}>
                <Zap size={32} className="text-blue-400" />
              </motion.div>
              <p className="mt-4 text-sm text-gray-400 font-medium">正在部署蓝图中的所有资源...</p>
            </motion.div>
          )}

          {status !== 'deploying' && (
            <>
              {/* Agents */}
              <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
                <div className="px-5 py-4 border-b border-gray-700 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Bot size={18} className="text-blue-400" />
                    <h3 className="font-semibold text-white">AI Agent 团队</h3>
                    <span className="text-xs px-2 py-0.5 bg-blue-500/20 text-blue-400 rounded-full font-medium">{blueprint.agents.length} 个</span>
                  </div>
                  {status === 'ready' && (
                    <button className="inline-flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-700 rounded-lg transition-colors">
                      <Plus size={14} /> 添加 Agent
                    </button>
                  )}
                </div>
                <div className="divide-y divide-gray-700">
                  {blueprint.agents.map(agent => (
                    <div key={agent.id} className="px-5 py-3">
                      <div className="flex items-center gap-3 cursor-pointer" onClick={() => toggleAgent(agent.id)}>
                        {status === 'ready' && <GripVertical size={14} className="text-gray-600" />}
                        <div className="w-8 h-8 rounded-full bg-blue-500/15 flex items-center justify-center">
                          <Bot size={14} className="text-blue-400" />
                        </div>
                        <div className="flex-1">
                          <span className="text-sm font-medium text-gray-200">{agent.name}</span>
                          <p className="text-xs text-gray-500">{agent.role}</p>
                        </div>
                        {expandedAgents.has(agent.id) ? <ChevronDown size={16} className="text-gray-500" /> : <ChevronRight size={16} className="text-gray-500" />}
                      </div>
                      <AnimatePresence>
                        {expandedAgents.has(agent.id) && (
                          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                            <div className="mt-3 ml-11 flex flex-wrap gap-1.5">
                              {agent.skills.map(skill => (
                                <span key={skill} className="px-2.5 py-1 bg-gray-700 text-gray-400 text-xs rounded-lg">{skill}</span>
                              ))}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  ))}
                </div>
              </div>

              {/* Workflows */}
              <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
                <div className="px-5 py-4 border-b border-gray-700 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Zap size={18} className="text-amber-400" />
                    <h3 className="font-semibold text-white">自动化工作流</h3>
                    <span className="text-xs px-2 py-0.5 bg-amber-500/20 text-amber-400 rounded-full font-medium">{blueprint.workflows.length} 个</span>
                  </div>
                  {status === 'ready' && (
                    <button className="inline-flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-700 rounded-lg transition-colors">
                      <Plus size={14} /> 添加工作流
                    </button>
                  )}
                </div>
                <div className="divide-y divide-gray-700">
                  {blueprint.workflows.map(wf => (
                    <div key={wf.id} className="px-5 py-3">
                      <div className="flex items-center gap-3 cursor-pointer" onClick={() => toggleWorkflow(wf.id)}>
                        <div className="w-8 h-8 rounded-full bg-amber-500/15 flex items-center justify-center">
                          <Zap size={14} className="text-amber-400" />
                        </div>
                        <div className="flex-1">
                          <span className="text-sm font-medium text-gray-200">{wf.name}</span>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-xs text-gray-500 flex items-center gap-1"><Clock size={10} />{wf.trigger}{wf.schedule && ` · ${wf.schedule}`}</span>
                          </div>
                        </div>
                        {expandedWorkflows.has(wf.id) ? <ChevronDown size={16} className="text-gray-500" /> : <ChevronRight size={16} className="text-gray-500" />}
                      </div>
                      <AnimatePresence>
                        {expandedWorkflows.has(wf.id) && (
                          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                            <div className="mt-3 ml-11">
                              <div className="flex items-start gap-2">
                                <div className="flex flex-col items-center">
                                  {wf.nodes.map((_, i) => (
                                    <div key={i} className="flex flex-col items-center">
                                      <div className="w-2 h-2 rounded-full bg-amber-400" />
                                      {i < wf.nodes.length - 1 && <div className="w-0.5 h-6 bg-amber-400/30" />}
                                    </div>
                                  ))}
                                </div>
                                <div className="space-y-3 -mt-1">
                                  {wf.nodes.map((node, i) => (
                                    <div key={i} className="text-xs text-gray-400 leading-none py-0.5">{node}</div>
                                  ))}
                                </div>
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  ))}
                </div>
              </div>

              {/* Connectors */}
              <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
                <div className="px-5 py-4 border-b border-gray-700 flex items-center gap-2">
                  <Globe size={18} className="text-cyan-400" />
                  <h3 className="font-semibold text-white">需要连接的服务</h3>
                </div>
                <div className="divide-y divide-gray-700">
                  {blueprint.connectors.map(conn => (
                    <div key={conn.id} className="px-5 py-3 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center ${conn.status === 'connected' ? 'bg-emerald-500/20' : 'bg-gray-700'}`}>
                          <Globe size={14} className={conn.status === 'connected' ? 'text-emerald-400' : 'text-gray-500'} />
                        </div>
                        <div>
                          <span className="text-sm font-medium text-gray-200">{conn.name}</span>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-xs text-gray-500">{conn.authType}</span>
                            {conn.status === 'required' && <span className="text-xs px-1.5 py-0.5 bg-rose-500/20 text-rose-400 rounded font-medium">必需</span>}
                            {conn.status === 'optional' && <span className="text-xs px-1.5 py-0.5 bg-gray-700 text-gray-500 rounded font-medium">可选</span>}
                          </div>
                        </div>
                      </div>
                      {status === 'ready' && (
                        <button className="px-3 py-1.5 text-xs font-medium text-gray-300 bg-gray-700 border border-gray-600 rounded-lg hover:bg-gray-600 transition-colors">
                          授权连接
                        </button>
                      )}
                      {status === 'deployed' && conn.status === 'required' && (
                        <div className="flex items-center gap-1.5 text-xs text-amber-400">
                          <AlertCircle size={12} /> 待授权
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </motion.div>
      )}
    </div>
  )
}
