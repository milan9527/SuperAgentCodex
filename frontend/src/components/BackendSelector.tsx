/**
 * BackendSelector
 *
 * A dialog component shown during the app publish flow that lets users
 * choose what kind of backend data service their app needs:
 * - None (pure frontend)
 * - Built-in lightweight storage (existing app_data JSONB)
 * - InsForge full-featured backend (PostgreSQL + Auth + Storage + Functions + MCP)
 *
 * When InsForge is selected, the orchestrator provisions a dedicated
 * Docker Compose stack for the app.
 */

import { useState } from 'react'
import {
  Database, Zap,
  Server, X, Loader2, CheckCircle2, AlertCircle, Cpu,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackendType = 'none' | 'builtin' | 'insforge'
export type InstanceType = 'nano' | 'micro' | 'small' | 'medium' | 'large'

export interface BackendSelection {
  type: BackendType
  instanceType?: InstanceType
}

interface BackendSelectorProps {
  open: boolean
  onClose: () => void
  onConfirm: (selection: BackendSelection) => void
  appName: string
  /** If true, show provisioning progress instead of selection */
  provisioning?: boolean
  provisioningStep?: string
  provisioningError?: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INSTANCE_TYPES: { value: InstanceType; label: string; desc: string }[] = [
  { value: 'nano', label: 'Nano', desc: '开发/测试，500MB 数据库' },
  { value: 'micro', label: 'Micro', desc: '小型工具，1GB 数据库' },
  { value: 'small', label: 'Small', desc: '团队协作，5GB 数据库' },
  { value: 'medium', label: 'Medium', desc: '部门业务，20GB 数据库' },
  { value: 'large', label: 'Large', desc: '企业核心，100GB 数据库' },
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BackendSelector({
  open,
  onClose,
  onConfirm,
  appName,
  provisioning = false,
  provisioningStep,
  provisioningError,
}: BackendSelectorProps) {
  const [selected, setSelected] = useState<BackendType>('none')
  const [instanceType, setInstanceType] = useState<InstanceType>('nano')

  if (!open) return null

  const handleConfirm = () => {
    onConfirm({
      type: selected,
      instanceType: selected === 'insforge' ? instanceType : undefined,
    })
  }

  // ── Provisioning Progress View ──
  if (provisioning) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md p-6 shadow-2xl">
          <div className="text-center">
            {provisioningError ? (
              <>
                <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-3" />
                <h3 className="text-lg font-semibold text-white mb-2">创建失败</h3>
                <p className="text-sm text-red-300 mb-4">{provisioningError}</p>
                <button
                  onClick={onClose}
                  className="px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600 transition-colors"
                >
                  关闭
                </button>
              </>
            ) : (
              <>
                <Loader2 className="w-12 h-12 text-purple-400 mx-auto mb-3 animate-spin" />
                <h3 className="text-lg font-semibold text-white mb-2">正在创建应用后端...</h3>
                <p className="text-sm text-gray-400 mb-4">
                  {provisioningStep || '分配资源中...'}
                </p>
                <div className="bg-gray-800 rounded-lg p-3 text-left space-y-2">
                  <ProvisionStep label="分配资源" done={stepIndex(provisioningStep) > 0} active={stepIndex(provisioningStep) === 0} />
                  <ProvisionStep label="创建数据库" done={stepIndex(provisioningStep) > 1} active={stepIndex(provisioningStep) === 1} />
                  <ProvisionStep label="配置认证服务" done={stepIndex(provisioningStep) > 2} active={stepIndex(provisioningStep) === 2} />
                  <ProvisionStep label="启动服务" done={stepIndex(provisioningStep) > 3} active={stepIndex(provisioningStep) === 3} />
                  <ProvisionStep label="健康检查" done={stepIndex(provisioningStep) > 4} active={stepIndex(provisioningStep) === 4} />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── Selection View ──
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg p-6 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="text-lg font-semibold text-white">后端数据服务</h3>
            <p className="text-sm text-gray-400 mt-0.5">
              为 <span className="text-purple-300">{appName}</span> 选择后端类型
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Options */}
        <div className="space-y-3 mb-5">
          {/* None */}
          <BackendOption
            selected={selected === 'none'}
            onClick={() => setSelected('none')}
            icon={<Zap className="w-5 h-5" />}
            iconColor="text-gray-400"
            title="无后端"
            description="纯展示型应用，不需要存储数据"
            tags={[]}
          />

          {/* Built-in */}
          <BackendOption
            selected={selected === 'builtin'}
            onClick={() => setSelected('builtin')}
            icon={<Database className="w-5 h-5" />}
            iconColor="text-blue-400"
            title="轻量存储"
            description="简单的 JSON 文档存储，适合配置、笔记类应用"
            tags={['免费', '即时可用']}
          />

          {/* InsForge */}
          <BackendOption
            selected={selected === 'insforge'}
            onClick={() => setSelected('insforge')}
            icon={<Server className="w-5 h-5" />}
            iconColor="text-purple-400"
            title="全功能后端 (InsForge)"
            description="独立数据库 + 用户认证 + 文件存储 + 实时同步"
            tags={['PostgreSQL', '用户认证', '文件存储', 'Agent 可访问']}
            recommended
          />
        </div>

        {/* Instance type selector (only for InsForge) */}
        {selected === 'insforge' && (
          <div className="mb-5 bg-gray-800/50 border border-gray-700 rounded-xl p-4">
            <label className="text-sm font-medium text-gray-300 mb-2 block">实例规格</label>
            <select
              value={instanceType}
              onChange={e => setInstanceType(e.target.value as InstanceType)}
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
            >
              {INSTANCE_TYPES.map(t => (
                <option key={t.value} value={t.value}>
                  {t.label} — {t.desc}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-2 flex items-center gap-1">
              <Cpu className="w-3 h-3" />
              预计创建时间: 30-60 秒
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            className="px-5 py-2 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-500 transition-colors flex items-center gap-2"
          >
            {selected === 'none' ? '跳过，直接发布' : '确认并发布'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function BackendOption({
  selected,
  onClick,
  icon,
  iconColor,
  title,
  description,
  tags,
  recommended,
}: {
  selected: boolean
  onClick: () => void
  icon: React.ReactNode
  iconColor: string
  title: string
  description: string
  tags: string[]
  recommended?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-4 rounded-xl border transition-all ${
        selected
          ? 'border-purple-500 bg-purple-500/10 ring-1 ring-purple-500/30'
          : 'border-gray-700 bg-gray-800/50 hover:border-gray-600 hover:bg-gray-800'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 ${iconColor}`}>{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-white">{title}</span>
            {recommended && (
              <span className="text-[10px] px-1.5 py-0.5 bg-purple-500/20 text-purple-300 rounded-full border border-purple-500/30">
                推荐 ⭐
              </span>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-0.5">{description}</p>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {tags.map(tag => (
                <span
                  key={tag}
                  className="text-[10px] px-1.5 py-0.5 bg-gray-700/50 text-gray-400 rounded"
                >
                  ✓ {tag}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className={`w-4 h-4 rounded-full border-2 flex-shrink-0 mt-0.5 flex items-center justify-center ${
          selected ? 'border-purple-500 bg-purple-500' : 'border-gray-600'
        }`}>
          {selected && <div className="w-1.5 h-1.5 bg-white rounded-full" />}
        </div>
      </div>
    </button>
  )
}

function ProvisionStep({ label, done, active }: { label: string; done: boolean; active: boolean }) {
  return (
    <div className="flex items-center gap-2">
      {done ? (
        <CheckCircle2 className="w-4 h-4 text-green-400" />
      ) : active ? (
        <Loader2 className="w-4 h-4 text-purple-400 animate-spin" />
      ) : (
        <div className="w-4 h-4 rounded-full border border-gray-600" />
      )}
      <span className={`text-xs ${done ? 'text-green-400' : active ? 'text-white' : 'text-gray-500'}`}>
        {label}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stepIndex(step?: string): number {
  if (!step) return 0
  const steps = ['分配资源', '创建数据库', '配置认证', '启动服务', '健康检查', '完成']
  const idx = steps.findIndex(s => step.includes(s))
  return idx >= 0 ? idx : 0
}
