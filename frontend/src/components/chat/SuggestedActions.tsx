/**
 * SuggestedActions — "建议下一步" quick action buttons.
 *
 * Displayed after AI generates a file, suggesting follow-up operations
 * the user might want to perform. Clicking a suggestion sends it as
 * a new message to the chat.
 */

import { Sparkles } from 'lucide-react'

export interface SuggestedAction {
  label: string
  prompt: string
}

interface SuggestedActionsProps {
  actions: SuggestedAction[]
  onAction: (prompt: string) => void
}

/**
 * Infer suggested actions based on the generated file type and name.
 */
export function inferSuggestedActions(fileName: string): SuggestedAction[] {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  const baseName = fileName.replace(/\.[^.]+$/, '')

  const actions: SuggestedAction[] = []

  // Common actions for all file types
  if (['md', 'txt', 'docx'].includes(ext)) {
    actions.push(
      { label: '调整格式', prompt: `请帮我优化 ${fileName} 的格式和排版` },
      { label: '生成 PPT 大纲', prompt: `基于 ${fileName} 的内容，帮我生成一份 PPT 演示文稿的大纲` },
      { label: '翻译成英文', prompt: `请将 ${fileName} 翻译成英文版本` },
    )
  }

  if (['xlsx', 'csv'].includes(ext)) {
    actions.push(
      { label: '生成图表', prompt: `基于 ${fileName} 的数据，帮我生成可视化图表` },
      { label: '数据分析', prompt: `请分析 ${fileName} 中的数据，给出关键洞察` },
    )
  }

  if (['html', 'htm'].includes(ext)) {
    actions.push(
      { label: '优化样式', prompt: `请优化 ${fileName} 的视觉设计和样式` },
      { label: '添加交互', prompt: `请为 ${fileName} 添加更多交互功能` },
    )
  }

  if (ext === 'md') {
    actions.push(
      { label: '扩展内容', prompt: `请扩展 ${fileName} 中的内容，增加更多细节` },
    )
  }

  // Generic fallback
  if (actions.length === 0) {
    actions.push(
      { label: '修改内容', prompt: `请帮我修改 ${fileName}` },
      { label: '生成相关文档', prompt: `基于 ${fileName}，帮我生成相关的配套文档` },
    )
  }

  // Limit to 3 suggestions
  return actions.slice(0, 3)
}

export function SuggestedActions({ actions, onAction }: SuggestedActionsProps) {
  if (actions.length === 0) return null

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="text-[10px] text-gray-500 flex items-center gap-1">
        <Sparkles className="w-3 h-3" />
        建议下一步
      </span>
      {actions.map((action, i) => (
        <button
          key={i}
          onClick={() => onAction(action.prompt)}
          className="px-2.5 py-1 text-xs text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-full hover:bg-blue-500/20 hover:border-blue-500/30 transition-colors"
        >
          {action.label}
        </button>
      ))}
    </div>
  )
}
