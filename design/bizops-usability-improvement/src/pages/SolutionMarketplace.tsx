import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search, Filter, TrendingUp, Users, Headphones,
  Star, ArrowRight, Check, Zap, Clock, Bot, Globe,
  Target, Sparkles, X
} from 'lucide-react'

const categories = [
  { id: 'all', label: '全部', count: 12 },
  { id: 'marketing', label: '营销增长', count: 4 },
  { id: 'support', label: '客户服务', count: 3 },
  { id: 'hr', label: '人力资源', count: 3 },
  { id: 'ops', label: '运营管理', count: 2 },
]

const solutions = [
  {
    id: 'brand-growth',
    category: 'marketing',
    name: '品牌增长套件',
    description: '输入品牌域名，自动生成品牌定位、竞品分析、内容策略和每日增长机会推送',
    icon: TrendingUp,
    color: 'bg-emerald-500',
    rating: 4.8,
    installs: 234,
    agents: 5,
    workflows: 4,
    skills: 12,
    tags: ['社交监听', 'SEO/GEO', '红人发现', '内容创作'],
    featured: true,
    variables: [
      { key: 'brand_domain', label: '品牌域名', placeholder: 'example.com', type: 'text' as const },
      { key: 'brand_name', label: '品牌名称', placeholder: '你的品牌名', type: 'text' as const },
      { key: 'target_market', label: '目标市场', placeholder: '选择市场', type: 'select' as const, options: ['中国大陆', '北美', '欧洲', '东南亚', '全球'] },
      { key: 'competitors', label: '主要竞品', placeholder: '输入竞品域名，逗号分隔', type: 'text' as const },
      { key: 'platforms', label: '关注平台', placeholder: '选择平台', type: 'multiselect' as const, options: ['X/Twitter', 'Reddit', 'YouTube', '小红书', 'LinkedIn', 'TikTok'] },
    ],
    includes: {
      agents: ['品牌策略师', '社交监听员', '内容创作者', 'SEO/GEO 专家', '红人经理'],
      workflows: ['品牌诊断分析', '每日增长机会扫描', '周度品牌健康报告', '红人发现与评估'],
      connectors: ['Twitter/X API', 'Reddit API', 'Google Search Console'],
    }
  },
  {
    id: 'customer-support',
    category: 'support',
    name: '智能客服中心',
    description: '多渠道客服自动化，智能路由、自动回复、满意度追踪一站式解决',
    icon: Headphones,
    color: 'bg-blue-500',
    rating: 4.6,
    installs: 189,
    agents: 4,
    workflows: 3,
    skills: 8,
    tags: ['多渠道', '智能路由', '知识库', '满意度'],
    featured: false,
    variables: [],
    includes: { agents: [], workflows: [], connectors: [] },
  },
  {
    id: 'talent-acquisition',
    category: 'hr',
    name: 'AI 招聘助手',
    description: '从简历筛选到面试安排，全流程自动化招聘管理',
    icon: Users,
    color: 'bg-purple-500',
    rating: 4.5,
    installs: 156,
    agents: 3,
    workflows: 5,
    skills: 9,
    tags: ['简历筛选', '面试安排', '候选人评估', '入职引导'],
    featured: false,
    variables: [],
    includes: { agents: [], workflows: [], connectors: [] },
  },
  {
    id: 'content-ops',
    category: 'marketing',
    name: '内容运营工厂',
    description: '从选题策划到多平台分发，AI 驱动的内容生产流水线',
    icon: Sparkles,
    color: 'bg-amber-500',
    rating: 4.7,
    installs: 312,
    agents: 4,
    workflows: 6,
    skills: 15,
    tags: ['选题策划', '内容生成', '多平台分发', '数据复盘'],
    featured: true,
    variables: [],
    includes: { agents: [], workflows: [], connectors: [] },
  },
  {
    id: 'sales-automation',
    category: 'ops',
    name: '销售自动化',
    description: '线索评分、跟进提醒、合同管理，让销售团队专注成交',
    icon: Target,
    color: 'bg-rose-500',
    rating: 4.4,
    installs: 98,
    agents: 3,
    workflows: 4,
    skills: 7,
    tags: ['线索评分', '跟进管理', 'CRM 集成', '业绩报表'],
    featured: false,
    variables: [],
    includes: { agents: [], workflows: [], connectors: [] },
  },
  {
    id: 'social-media',
    category: 'marketing',
    name: '社交媒体管家',
    description: '统一管理多平台社交账号，智能排期、自动互动、数据分析',
    icon: Globe,
    color: 'bg-cyan-500',
    rating: 4.3,
    installs: 145,
    agents: 3,
    workflows: 3,
    skills: 10,
    tags: ['多平台管理', '内容排期', '互动管理', '数据分析'],
    featured: false,
    variables: [],
    includes: { agents: [], workflows: [], connectors: [] },
  },
]

export default function SolutionMarketplace() {
  const [activeCategory, setActiveCategory] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedSolution, setSelectedSolution] = useState<typeof solutions[0] | null>(null)
  const [deployStep, setDeployStep] = useState(0)
  const [formValues, setFormValues] = useState<Record<string, string>>({})

  const filteredSolutions = solutions.filter(s => {
    if (activeCategory !== 'all' && s.category !== activeCategory) return false
    if (searchQuery && !s.name.includes(searchQuery) && !s.description.includes(searchQuery)) return false
    return true
  })

  const handleDeploy = () => {
    setDeployStep(3)
    setTimeout(() => setDeployStep(4), 3000)
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-2">解决方案市场</h1>
        <p className="text-gray-400">选择一个行业解决方案，填入业务信息，30 分钟内上线完整的 AI 业务流程</p>
      </div>

      {/* Search & Filter */}
      <div className="flex items-center gap-4 mb-6">
        <div className="relative flex-1 max-w-md">
          <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            placeholder="搜索解决方案..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-gray-700 bg-gray-800 text-sm text-white placeholder-gray-500
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <button className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-gray-800 text-gray-300 text-sm font-medium border border-gray-700 hover:bg-gray-700 transition-colors">
          <Filter size={16} />
          筛选
        </button>
      </div>

      {/* Categories */}
      <div className="flex items-center gap-2 mb-8 overflow-x-auto pb-2">
        {categories.map(cat => (
          <button
            key={cat.id}
            onClick={() => setActiveCategory(cat.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
              activeCategory === cat.id
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 hover:bg-gray-700'
            }`}
          >
            {cat.label}
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${
              activeCategory === cat.id ? 'bg-blue-500 text-white' : 'bg-gray-700 text-gray-500'
            }`}>
              {cat.count}
            </span>
          </button>
        ))}
      </div>

      {/* Solution Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {filteredSolutions.map(solution => (
          <motion.div
            key={solution.id}
            layout
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="relative bg-gray-800 rounded-xl border border-gray-700 p-5 cursor-pointer
                       hover:border-blue-500/50 hover:shadow-lg hover:shadow-blue-500/5 transition-all duration-200 group"
            onClick={() => { setSelectedSolution(solution); setDeployStep(1); }}
          >
            {solution.featured && (
              <div className="absolute top-3 right-3 px-2 py-0.5 bg-amber-500/20 text-amber-400 text-xs font-medium rounded-full">
                推荐
              </div>
            )}
            <div className="flex items-start gap-4 mb-4">
              <div className={`w-11 h-11 rounded-xl ${solution.color} flex items-center justify-center flex-shrink-0`}>
                <solution.icon size={22} className="text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-white group-hover:text-blue-400 transition-colors">
                  {solution.name}
                </h3>
                <div className="flex items-center gap-2 mt-1">
                  <div className="flex items-center gap-0.5">
                    <Star size={12} className="text-amber-400 fill-amber-400" />
                    <span className="text-xs text-gray-400">{solution.rating}</span>
                  </div>
                  <span className="text-xs text-gray-600">·</span>
                  <span className="text-xs text-gray-500">{solution.installs} 次部署</span>
                </div>
              </div>
            </div>
            <p className="text-sm text-gray-400 mb-4 line-clamp-2">{solution.description}</p>
            <div className="flex items-center gap-3 text-xs text-gray-500 mb-3">
              <span className="flex items-center gap-1"><Bot size={12} />{solution.agents} Agent</span>
              <span className="flex items-center gap-1"><Zap size={12} />{solution.workflows} Workflow</span>
              <span className="flex items-center gap-1"><Sparkles size={12} />{solution.skills} Skill</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {solution.tags.map(tag => (
                <span key={tag} className="px-2 py-0.5 bg-gray-700 text-gray-400 text-xs rounded-md">
                  {tag}
                </span>
              ))}
            </div>
          </motion.div>
        ))}
      </div>

      {/* Solution Detail / Deploy Modal */}
      <AnimatePresence>
        {selectedSolution && deployStep >= 1 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
            onClick={() => { setSelectedSolution(null); setDeployStep(0); setFormValues({}); }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.2 }}
              className="bg-gray-800 rounded-2xl border border-gray-700 shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col"
              onClick={e => e.stopPropagation()}
            >
              {/* Modal Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-xl ${selectedSolution.color} flex items-center justify-center`}>
                    <selectedSolution.icon size={20} className="text-white" />
                  </div>
                  <div>
                    <h2 className="font-semibold text-white">{selectedSolution.name}</h2>
                    <p className="text-xs text-gray-500">
                      {deployStep === 1 && '方案详情'}
                      {deployStep === 2 && '配置业务信息'}
                      {deployStep === 3 && '正在部署...'}
                      {deployStep === 4 && '部署完成'}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => { setSelectedSolution(null); setDeployStep(0); setFormValues({}); }}
                  className="p-2 rounded-lg hover:bg-gray-700 text-gray-500"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Modal Body */}
              <div className="flex-1 overflow-y-auto px-6 py-5">
                {deployStep === 1 && (
                  <div className="space-y-6">
                    <p className="text-gray-300">{selectedSolution.description}</p>
                    {selectedSolution.includes.agents.length > 0 && (
                      <>
                        <div>
                          <h4 className="text-sm font-semibold text-gray-200 mb-3 flex items-center gap-2">
                            <Bot size={16} className="text-blue-400" />
                            包含的 AI Agent
                          </h4>
                          <div className="grid grid-cols-1 gap-2">
                            {selectedSolution.includes.agents.map(agent => (
                              <div key={agent} className="flex items-center gap-3 p-3 rounded-lg bg-gray-900/50">
                                <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center">
                                  <Bot size={14} className="text-blue-400" />
                                </div>
                                <span className="text-sm text-gray-300 font-medium">{agent}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div>
                          <h4 className="text-sm font-semibold text-gray-200 mb-3 flex items-center gap-2">
                            <Zap size={16} className="text-amber-400" />
                            自动化工作流
                          </h4>
                          <div className="grid grid-cols-1 gap-2">
                            {selectedSolution.includes.workflows.map(wf => (
                              <div key={wf} className="flex items-center gap-3 p-3 rounded-lg bg-gray-900/50">
                                <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center">
                                  <Zap size={14} className="text-amber-400" />
                                </div>
                                <span className="text-sm text-gray-300 font-medium">{wf}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div>
                          <h4 className="text-sm font-semibold text-gray-200 mb-3 flex items-center gap-2">
                            <Globe size={16} className="text-cyan-400" />
                            需要连接的服务
                          </h4>
                          <div className="flex flex-wrap gap-2">
                            {selectedSolution.includes.connectors.map(c => (
                              <span key={c} className="px-3 py-1.5 bg-cyan-500/10 text-cyan-400 text-sm rounded-lg border border-cyan-500/30">
                                {c}
                              </span>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {deployStep === 2 && selectedSolution.variables.length > 0 && (
                  <div className="space-y-5">
                    <p className="text-sm text-gray-400 mb-4">
                      填入你的业务信息，系统将自动配置所有 Agent 和工作流
                    </p>
                    {selectedSolution.variables.map(v => (
                      <div key={v.key}>
                        <label className="block text-sm font-medium text-gray-300 mb-1.5">{v.label}</label>
                        {v.type === 'text' && (
                          <input
                            type="text"
                            placeholder={v.placeholder}
                            value={formValues[v.key] || ''}
                            onChange={e => setFormValues(prev => ({ ...prev, [v.key]: e.target.value }))}
                            className="w-full px-3.5 py-2.5 rounded-lg border border-gray-700 bg-gray-900 text-sm text-white placeholder-gray-500
                                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          />
                        )}
                        {v.type === 'select' && (
                          <select
                            value={formValues[v.key] || ''}
                            onChange={e => setFormValues(prev => ({ ...prev, [v.key]: e.target.value }))}
                            className="w-full px-3.5 py-2.5 rounded-lg border border-gray-700 bg-gray-900 text-sm text-white
                                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          >
                            <option value="">{v.placeholder}</option>
                            {v.options?.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                          </select>
                        )}
                        {v.type === 'multiselect' && (
                          <div className="flex flex-wrap gap-2 mt-1">
                            {v.options?.map(opt => {
                              const selected = (formValues[v.key] || '').split(',').includes(opt)
                              return (
                                <button
                                  key={opt}
                                  onClick={() => {
                                    const current = (formValues[v.key] || '').split(',').filter(Boolean)
                                    const next = selected ? current.filter(x => x !== opt) : [...current, opt]
                                    setFormValues(prev => ({ ...prev, [v.key]: next.join(',') }))
                                  }}
                                  className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                                    selected
                                      ? 'bg-blue-500/20 border-blue-500/50 text-blue-400'
                                      : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-600'
                                  }`}
                                >
                                  {selected && <Check size={12} className="inline mr-1" />}
                                  {opt}
                                </button>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {deployStep === 3 && (
                  <div className="flex flex-col items-center justify-center py-12">
                    <div className="w-16 h-16 rounded-full bg-blue-500/20 flex items-center justify-center mb-6">
                      <motion.div animate={{ rotate: 360 }} transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}>
                        <Zap size={28} className="text-blue-400" />
                      </motion.div>
                    </div>
                    <h3 className="text-lg font-semibold text-white mb-2">正在部署解决方案</h3>
                    <p className="text-sm text-gray-500 mb-8">正在创建 Agent、配置工作流、绑定技能包...</p>
                    <div className="w-full max-w-sm space-y-3">
                      {['创建业务域 (Scope)', '配置 5 个 AI Agent', '绑定 12 个技能包', '部署 4 个工作流', '设置定时调度'].map((step, i) => (
                        <motion.div
                          key={step}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: i * 0.5 }}
                          className="flex items-center gap-3"
                        >
                          <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: i * 0.5 + 0.3 }}>
                            <Check size={16} className="text-emerald-400" />
                          </motion.div>
                          <span className="text-sm text-gray-300">{step}</span>
                        </motion.div>
                      ))}
                    </div>
                  </div>
                )}

                {deployStep === 4 && (
                  <div className="flex flex-col items-center justify-center py-12">
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: 'spring', stiffness: 200 }}
                      className="w-16 h-16 rounded-full bg-emerald-500/20 flex items-center justify-center mb-6"
                    >
                      <Check size={32} className="text-emerald-400" />
                    </motion.div>
                    <h3 className="text-lg font-semibold text-white mb-2">部署完成!</h3>
                    <p className="text-sm text-gray-500 mb-6">品牌增长套件已就绪，系统将在明天 8:00 开始首次扫描</p>
                    <div className="bg-gray-900 rounded-xl border border-gray-700 p-4 w-full max-w-sm">
                      <div className="text-xs text-gray-500 mb-2">已创建的资源</div>
                      <div className="space-y-2">
                        {[['AI Agent', '5 个'], ['自动化工作流', '4 个'], ['技能包', '12 个'], ['定时任务', '2 个']].map(([label, val]) => (
                          <div key={label} className="flex items-center justify-between text-sm">
                            <span className="text-gray-400">{label}</span>
                            <span className="font-medium text-blue-400">{val}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div className="px-6 py-4 border-t border-gray-700 flex items-center justify-between">
                {deployStep === 1 && (
                  <>
                    <button className="px-3 py-2 text-sm text-gray-400 hover:text-gray-200" onClick={() => { setSelectedSolution(null); setDeployStep(0); }}>
                      返回
                    </button>
                    <button className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 transition-colors" onClick={() => setDeployStep(2)}>
                      开始部署 <ArrowRight size={16} />
                    </button>
                  </>
                )}
                {deployStep === 2 && (
                  <>
                    <button className="px-3 py-2 text-sm text-gray-400 hover:text-gray-200" onClick={() => setDeployStep(1)}>上一步</button>
                    <button className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 transition-colors" onClick={handleDeploy}>
                      确认部署 <Zap size={16} />
                    </button>
                  </>
                )}
                {deployStep === 4 && (
                  <>
                    <div />
                    <button className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 transition-colors" onClick={() => { setSelectedSolution(null); setDeployStep(0); setFormValues({}); }}>
                      进入工作台 <ArrowRight size={16} />
                    </button>
                  </>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
