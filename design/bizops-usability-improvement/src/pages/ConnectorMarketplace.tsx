import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search, Check, X, Shield, Zap,
  Globe, Mail, Database, BarChart3, MessageCircle, Video,
  Users, Smartphone, ArrowRight,
  Lock, Unlock, RefreshCw, Settings
} from 'lucide-react'

type ConnectorStatus = 'available' | 'connected'

interface Connector {
  id: string
  name: string
  description: string
  category: string
  icon: any
  iconColor: string
  iconBg: string
  authType: string
  status: ConnectorStatus
  popular?: boolean
  features: string[]
}

const categories = [
  { id: 'all', label: '全部' },
  { id: 'social', label: '社交媒体' },
  { id: 'search', label: '搜索引擎' },
  { id: 'analytics', label: '数据分析' },
  { id: 'communication', label: '通讯协作' },
  { id: 'crm', label: 'CRM' },
]

const connectors: Connector[] = [
  { id: 'twitter', name: 'Twitter / X', description: '社交监听、内容发布、互动管理和趋势追踪', category: 'social', icon: Globe, iconColor: 'text-sky-400', iconBg: 'bg-sky-500/20', authType: 'OAuth 2.0', status: 'available', popular: true, features: ['发布推文', '搜索话题', '监听关键词', '获取互动数据'] },
  { id: 'reddit', name: 'Reddit', description: '社区讨论监听、热帖追踪和品牌提及分析', category: 'social', icon: MessageCircle, iconColor: 'text-orange-400', iconBg: 'bg-orange-500/20', authType: 'OAuth 2.0', status: 'available', popular: true, features: ['搜索帖子', '监听 Subreddit', '评论分析', '趋势追踪'] },
  { id: 'youtube', name: 'YouTube', description: '视频内容分析、频道监控和评论管理', category: 'social', icon: Video, iconColor: 'text-red-400', iconBg: 'bg-red-500/20', authType: 'OAuth 2.0', status: 'connected', features: ['视频搜索', '频道分析', '评论监控', '趋势话题'] },
  { id: 'linkedin', name: 'LinkedIn', description: 'B2B 品牌曝光、内容发布和人脉拓展', category: 'social', icon: Users, iconColor: 'text-blue-400', iconBg: 'bg-blue-500/20', authType: 'OAuth 2.0', status: 'available', features: ['发布动态', '公司页面管理', '人脉搜索', '互动分析'] },
  { id: 'xiaohongshu', name: '小红书', description: '笔记监控、达人发现和内容趋势分析', category: 'social', icon: Smartphone, iconColor: 'text-rose-400', iconBg: 'bg-rose-500/20', authType: 'Cookie / 无头浏览器', status: 'available', features: ['笔记搜索', '达人分析', '话题趋势', '竞品监控'] },
  { id: 'gsc', name: 'Google Search Console', description: '搜索表现数据、关键词排名和索引状态监控', category: 'search', icon: BarChart3, iconColor: 'text-emerald-400', iconBg: 'bg-emerald-500/20', authType: 'OAuth 2.0', status: 'connected', popular: true, features: ['搜索查询数据', '页面表现', '索引覆盖', '核心网页指标'] },
  { id: 'ahrefs', name: 'Ahrefs', description: '外链分析、关键词研究和竞品 SEO 数据', category: 'analytics', icon: BarChart3, iconColor: 'text-indigo-400', iconBg: 'bg-indigo-500/20', authType: 'API Key', status: 'available', features: ['外链分析', '关键词难度', '竞品对比', '内容差距'] },
  { id: 'semrush', name: 'SEMrush', description: '全面的 SEO 和竞品分析工具集', category: 'analytics', icon: BarChart3, iconColor: 'text-orange-400', iconBg: 'bg-orange-500/20', authType: 'API Key', status: 'available', features: ['关键词研究', '排名追踪', '站点审计', '广告分析'] },
  { id: 'gmail', name: 'Gmail', description: '邮件搜索、发送、回复和标签管理', category: 'communication', icon: Mail, iconColor: 'text-red-400', iconBg: 'bg-red-500/20', authType: 'OAuth 2.0', status: 'connected', features: ['邮件搜索', '发送邮件', '标签管理', '自动回复'] },
  { id: 'slack', name: 'Slack', description: '消息推送、频道管理和团队协作通知', category: 'communication', icon: MessageCircle, iconColor: 'text-purple-400', iconBg: 'bg-purple-500/20', authType: 'OAuth 2.0', status: 'connected', features: ['发送消息', '频道管理', '文件分享', '工作流通知'] },
  { id: 'salesforce', name: 'Salesforce', description: 'CRM 数据查询、线索管理和销售流程自动化', category: 'crm', icon: Database, iconColor: 'text-blue-400', iconBg: 'bg-blue-500/20', authType: 'OAuth 2.0', status: 'available', features: ['线索管理', '商机追踪', '联系人查询', '报表生成'] },
  { id: 'tiktok', name: 'TikTok', description: '短视频趋势分析、达人发现和内容监控', category: 'social', icon: Video, iconColor: 'text-pink-400', iconBg: 'bg-pink-500/20', authType: 'OAuth 2.0', status: 'available', features: ['视频搜索', '达人分析', '话题趋势', '数据报告'] },
]

export default function ConnectorMarketplace() {
  const [activeCategory, setActiveCategory] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedConnector, setSelectedConnector] = useState<Connector | null>(null)
  const [connectingId, setConnectingId] = useState<string | null>(null)

  const filteredConnectors = connectors.filter(c => {
    if (activeCategory !== 'all' && c.category !== activeCategory) return false
    if (searchQuery && !c.name.toLowerCase().includes(searchQuery.toLowerCase()) && !c.description.includes(searchQuery)) return false
    return true
  })

  const connectedCount = connectors.filter(c => c.status === 'connected').length

  const handleConnect = (id: string) => {
    setConnectingId(id)
    setTimeout(() => setConnectingId(null), 2000)
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white mb-2">连接器市场</h1>
          <p className="text-gray-400">一键授权连接外部服务，让 Agent 获得真实数据源</p>
        </div>
        <div className="px-3 py-1.5 bg-emerald-500/20 text-emerald-400 rounded-lg text-sm font-medium flex items-center gap-2">
          <Check size={14} /> 已连接 {connectedCount} 个
        </div>
      </div>

      {/* Search */}
      <div className="flex items-center gap-4 mb-6">
        <div className="relative flex-1 max-w-md">
          <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            placeholder="搜索连接器..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-gray-700 bg-gray-800 text-sm text-white placeholder-gray-500
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
      </div>

      {/* Categories */}
      <div className="flex items-center gap-2 mb-8 overflow-x-auto pb-2">
        {categories.map(cat => (
          <button
            key={cat.id}
            onClick={() => setActiveCategory(cat.id)}
            className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
              activeCategory === cat.id
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 hover:bg-gray-700'
            }`}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredConnectors.map(connector => (
          <motion.div
            key={connector.id}
            layout
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className={`relative bg-gray-800 rounded-xl border p-5 cursor-pointer transition-all duration-200 ${
              connector.status === 'connected'
                ? 'border-emerald-500/30 hover:border-emerald-500/50'
                : 'border-gray-700 hover:border-blue-500/50'
            } hover:shadow-lg hover:shadow-blue-500/5`}
            onClick={() => setSelectedConnector(connector)}
          >
            {connector.status === 'connected' && (
              <div className="absolute top-3 right-3 flex items-center gap-1 px-2 py-0.5 bg-emerald-500/20 text-emerald-400 text-xs rounded-full font-medium">
                <Check size={10} /> 已连接
              </div>
            )}
            {connector.popular && connector.status !== 'connected' && (
              <div className="absolute top-3 right-3 px-2 py-0.5 bg-amber-500/20 text-amber-400 text-xs rounded-full font-medium">热门</div>
            )}

            <div className="flex items-start gap-4">
              <div className={`w-11 h-11 rounded-xl ${connector.iconBg} flex items-center justify-center flex-shrink-0`}>
                <connector.icon size={22} className={connector.iconColor} />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-white text-sm">{connector.name}</h3>
                <p className="text-xs text-gray-500 mt-1 line-clamp-2">{connector.description}</p>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs text-gray-500">
                <Shield size={12} /> {connector.authType}
              </div>
              {connector.status === 'available' && (
                <button
                  onClick={e => { e.stopPropagation(); handleConnect(connector.id); }}
                  disabled={connectingId === connector.id}
                  className="text-xs font-medium text-blue-400 hover:text-blue-300 flex items-center gap-1"
                >
                  {connectingId === connector.id ? (
                    <><motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}><RefreshCw size={12} /></motion.div>连接中...</>
                  ) : (
                    <>连接 <ArrowRight size={12} /></>
                  )}
                </button>
              )}
              {connector.status === 'connected' && (
                <button onClick={e => e.stopPropagation()} className="text-xs font-medium text-gray-500 hover:text-gray-300 flex items-center gap-1">
                  <Settings size={12} /> 管理
                </button>
              )}
            </div>
          </motion.div>
        ))}
      </div>

      {/* Detail Modal */}
      <AnimatePresence>
        {selectedConnector && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
            onClick={() => setSelectedConnector(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.2 }}
              className="bg-gray-800 rounded-2xl border border-gray-700 shadow-2xl w-full max-w-lg overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              <div className="px-6 py-5 border-b border-gray-700">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-xl ${selectedConnector.iconBg} flex items-center justify-center`}>
                      <selectedConnector.icon size={24} className={selectedConnector.iconColor} />
                    </div>
                    <div>
                      <h2 className="text-lg font-bold text-white">{selectedConnector.name}</h2>
                      <p className="text-sm text-gray-500">{selectedConnector.description}</p>
                    </div>
                  </div>
                  <button onClick={() => setSelectedConnector(null)} className="p-2 rounded-lg hover:bg-gray-700 text-gray-500">
                    <X size={18} />
                  </button>
                </div>
              </div>

              <div className="px-6 py-5 space-y-5">
                <div>
                  <h4 className="text-sm font-semibold text-gray-200 mb-3">支持的功能</h4>
                  <div className="grid grid-cols-2 gap-2">
                    {selectedConnector.features.map(feature => (
                      <div key={feature} className="flex items-center gap-2 text-sm text-gray-400">
                        <Check size={14} className="text-emerald-400 flex-shrink-0" /> {feature}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="p-4 bg-gray-900 rounded-xl border border-gray-700">
                  <div className="flex items-center gap-2 mb-2">
                    <Lock size={14} className="text-gray-500" />
                    <span className="text-sm font-medium text-gray-300">认证方式</span>
                  </div>
                  <p className="text-sm text-gray-400">{selectedConnector.authType}</p>
                  <p className="text-xs text-gray-500 mt-1">点击连接后将跳转到 {selectedConnector.name} 的授权页面，授权完成后自动返回</p>
                </div>

                <div>
                  <h4 className="text-sm font-semibold text-gray-200 mb-2">请求的权限</h4>
                  <div className="space-y-2">
                    {['读取公开数据和搜索结果', '代表你发布内容（可选）', '访问账户分析数据'].map(perm => (
                      <div key={perm} className="flex items-center gap-2 text-sm text-gray-400">
                        <Unlock size={14} className="text-blue-400" /> {perm}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="px-6 py-4 border-t border-gray-700 flex items-center justify-between">
                <button className="px-3 py-2 text-sm text-gray-400 hover:text-gray-200" onClick={() => setSelectedConnector(null)}>取消</button>
                {selectedConnector.status === 'available' ? (
                  <button
                    onClick={() => handleConnect(selectedConnector.id)}
                    disabled={connectingId === selectedConnector.id}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 disabled:opacity-60 transition-colors"
                  >
                    {connectingId === selectedConnector.id ? (
                      <><motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}><RefreshCw size={16} /></motion.div>正在连接...</>
                    ) : (
                      <><Zap size={16} />授权并连接</>
                    )}
                  </button>
                ) : (
                  <div className="flex items-center gap-3">
                    <button className="px-3 py-2 text-xs font-medium text-rose-400 border border-rose-500/30 rounded-lg hover:bg-rose-500/10 transition-colors">断开连接</button>
                    <button className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 transition-colors">
                      <RefreshCw size={16} /> 重新授权
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
