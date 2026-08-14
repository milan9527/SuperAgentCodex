/**
 * AgentCard — compact card view for the Agents page sidebar.
 * Shows avatar, name, role, call count, status, and scope tag.
 */

import type { Agent, AgentStatus } from '@/types'
import { getAvatarDisplayUrl, getAvatarFallback, shouldShowAvatarImage } from '@/utils/avatarUtils'

const statusColors: Record<AgentStatus, { dot: string; text: string }> = {
  active: { dot: 'bg-green-500', text: 'text-green-400' },
  busy: { dot: 'bg-blue-500', text: 'text-blue-400' },
  offline: { dot: 'bg-gray-500', text: 'text-gray-400' },
}

interface AgentCardProps {
  agent: Agent
  scopeName?: string
  isSelected?: boolean
  onClick?: () => void
}

export function AgentCard({ agent, scopeName, isSelected = false, onClick = () => {} }: AgentCardProps) {
  const statusStyle = statusColors[agent.status] || statusColors.active
  const avatarUrl = getAvatarDisplayUrl(agent.avatar)
  const avatarFallback = getAvatarFallback(agent.displayName, agent.avatar)
  const showImage = shouldShowAvatarImage(agent.avatar)

  return (
    <button
      onClick={onClick}
      className={`
        w-full p-3 rounded-lg text-left transition-all border
        ${isSelected
          ? 'bg-blue-600/20 border-blue-500/50'
          : 'bg-gray-800/40 border-gray-700/50 hover:bg-gray-800 hover:border-gray-600'
        }
      `}
    >
      {/* Top: Avatar + Name */}
      <div className="flex items-center gap-2.5 mb-2">
        <div className="relative flex-shrink-0">
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-sm font-medium overflow-hidden">
            {showImage && avatarUrl ? (
              <img
                src={avatarUrl}
                alt={agent.displayName}
                className="w-full h-full object-cover"
                onError={(e) => {
                  e.currentTarget.style.display = 'none'
                  e.currentTarget.parentElement!.textContent = avatarFallback
                }}
              />
            ) : avatarFallback}
          </div>
          <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${statusStyle.dot} border-2 border-gray-900`} />
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-medium truncate ${isSelected ? 'text-blue-400' : 'text-white'}`}>
            {agent.displayName}
          </p>
          <p className="text-xs text-gray-500 truncate">{agent.role}</p>
        </div>
      </div>

      {/* Bottom: Stats + Scope tag */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-[10px] text-gray-500">
          <span>{agent.metrics.taskCount} calls</span>
        </div>
        {scopeName && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700/50 text-gray-400 truncate max-w-[80px]">
            {scopeName}
          </span>
        )}
      </div>
    </button>
  )
}
