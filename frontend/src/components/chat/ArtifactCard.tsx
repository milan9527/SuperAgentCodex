/**
 * ArtifactCard — Displayed in the chat message flow when AI generates a file.
 *
 * Shows file name, type, and action buttons (查看 / 下载).
 * Clicking "查看" triggers the right-side preview panel to load the file.
 */

import { Eye, Download, FileText, Image, Table2, File as FileIcon, Code, Globe } from 'lucide-react'

export interface ArtifactInfo {
  /** Workspace-relative file path */
  path: string
  /** Display name (user-friendly, no extension if obvious) */
  name: string
  /** File type hint for icon selection */
  type?: 'document' | 'spreadsheet' | 'image' | 'code' | 'html' | 'other'
  /** Optional: file size in bytes */
  size?: number
  /** Optional: generation timestamp */
  generatedAt?: string
}

interface ArtifactCardProps {
  artifact: ArtifactInfo
  onView: (path: string, name: string) => void
  onDownload?: (path: string) => void
  isActive?: boolean
}

function ArtifactTypeIcon({ type }: { type?: string }) {
  switch (type) {
    case 'document': return <FileText className="w-5 h-5 text-blue-400" />
    case 'spreadsheet': return <Table2 className="w-5 h-5 text-green-400" />
    case 'image': return <Image className="w-5 h-5 text-purple-400" />
    case 'code': return <Code className="w-5 h-5 text-yellow-400" />
    case 'html': return <Globe className="w-5 h-5 text-orange-400" />
    default: return <FileIcon className="w-5 h-5 text-gray-400" />
  }
}

function inferType(path: string): ArtifactInfo['type'] {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  if (['md', 'txt', 'docx', 'doc', 'pdf'].includes(ext)) return 'document'
  if (['xlsx', 'xls', 'csv'].includes(ext)) return 'spreadsheet'
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return 'image'
  if (['html', 'htm'].includes(ext)) return 'html'
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'java', 'go', 'rs', 'rb'].includes(ext)) return 'code'
  return 'other'
}

function formatSize(bytes?: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ArtifactCard({ artifact, onView, onDownload, isActive }: ArtifactCardProps) {
  const type = artifact.type || inferType(artifact.path)
  const sizeStr = formatSize(artifact.size)

  return (
    <div
      className={`
        flex items-center gap-3 px-4 py-3 rounded-lg border transition-all cursor-pointer
        ${isActive
          ? 'bg-blue-900/20 border-blue-500/40 shadow-sm shadow-blue-500/10'
          : 'bg-gray-800/60 border-gray-700/60 hover:border-gray-600 hover:bg-gray-800/80'
        }
      `}
      onClick={() => onView(artifact.path, artifact.name)}
    >
      {/* Icon */}
      <div className="flex-shrink-0">
        <ArtifactTypeIcon type={type} />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white font-medium truncate">{artifact.name}</p>
        <p className="text-xs text-gray-500">
          文件生成完成{sizeStr ? ` · ${sizeStr}` : ''}
        </p>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          onClick={(e) => { e.stopPropagation(); onView(artifact.path, artifact.name) }}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 text-xs font-medium transition-colors"
        >
          <Eye className="w-3.5 h-3.5" />
          查看
        </button>
        {onDownload && (
          <button
            onClick={(e) => { e.stopPropagation(); onDownload(artifact.path) }}
            className="flex items-center gap-1 px-2 py-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-700 text-xs transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}
