/**
 * Knowledge Base Service
 *
 * API client for the new independent knowledge base system.
 * Handles CRUD for knowledge bases, folders, files, and scope bindings.
 */

import { restClient } from './api/restClient'

// ============================================================================
// Types
// ============================================================================

export interface KnowledgeBase {
  id: string
  organization_id: string
  name: string
  description: string | null
  icon: string | null
  status: string
  document_count: number
  total_size: number
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface KnowledgeFolder {
  id: string
  organization_id: string
  knowledge_base_id: string
  parent_id: string | null
  name: string
  path: string
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface KnowledgeFile {
  id: string
  organization_id: string
  knowledge_base_id: string
  folder_id: string | null
  display_name: string
  original_filename: string
  stored_filename: string
  s3_key: string
  file_size: number
  mime_type: string
  tags: string[]
  is_starred: boolean
  index_status: 'pending' | 'indexing' | 'indexed' | 'failed'
  version: number
  uploaded_by: string | null
  created_at: string
  updated_at: string
}

export interface PaginatedFiles {
  items: KnowledgeFile[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}

export interface ScopeKnowledgeBinding {
  id: string
  scope_id: string
  knowledge_base_id: string
  bound_by: string | null
  created_at: string
  knowledge_base: KnowledgeBase
}

export interface KnowledgeTag {
  tag: string
  count: number
}

// ============================================================================
// Service
// ============================================================================

export const KnowledgeBaseAPI = {
  // --------------------------------------------------------------------------
  // Knowledge Base CRUD
  // --------------------------------------------------------------------------

  async list(): Promise<KnowledgeBase[]> {
    const res = await restClient.get<{ data: KnowledgeBase[] }>('/api/knowledge-bases')
    return res.data
  },

  async get(id: string): Promise<KnowledgeBase> {
    const res = await restClient.get<{ data: KnowledgeBase }>(`/api/knowledge-bases/${id}`)
    return res.data
  },

  async create(input: { name: string; description?: string; icon?: string }): Promise<KnowledgeBase> {
    const res = await restClient.post<{ data: KnowledgeBase }>('/api/knowledge-bases', input)
    return res.data
  },

  async update(id: string, input: { name?: string; description?: string; icon?: string }): Promise<KnowledgeBase> {
    const res = await restClient.put<{ data: KnowledgeBase }>(`/api/knowledge-bases/${id}`, input)
    return res.data
  },

  async delete(id: string): Promise<void> {
    await restClient.delete(`/api/knowledge-bases/${id}`)
  },

  // --------------------------------------------------------------------------
  // Scope Bindings
  // --------------------------------------------------------------------------

  async getScopeBindings(scopeId: string): Promise<ScopeKnowledgeBinding[]> {
    const res = await restClient.get<{ data: ScopeKnowledgeBinding[] }>(
      `/api/knowledge-bases/scope/${scopeId}/bindings`
    )
    return res.data
  },

  async bindToScope(scopeId: string, knowledgeBaseId: string): Promise<void> {
    await restClient.post(`/api/knowledge-bases/scope/${scopeId}/bind`, {
      knowledge_base_id: knowledgeBaseId,
    })
  },

  async unbindFromScope(scopeId: string, knowledgeBaseId: string): Promise<void> {
    await restClient.delete(`/api/knowledge-bases/scope/${scopeId}/unbind/${knowledgeBaseId}`)
  },

  // --------------------------------------------------------------------------
  // Folders
  // --------------------------------------------------------------------------

  async listFolders(kbId: string, parentId?: string | null): Promise<KnowledgeFolder[]> {
    const params = parentId ? `?parent_id=${parentId}` : ''
    const res = await restClient.get<{ data: KnowledgeFolder[] }>(
      `/api/knowledge-bases/${kbId}/folders${params}`
    )
    return res.data
  },

  async createFolder(kbId: string, name: string, parentId?: string): Promise<KnowledgeFolder> {
    const res = await restClient.post<{ data: KnowledgeFolder }>(
      `/api/knowledge-bases/${kbId}/folders`,
      { name, parent_id: parentId }
    )
    return res.data
  },

  async renameFolder(kbId: string, folderId: string, name: string): Promise<KnowledgeFolder> {
    const res = await restClient.put<{ data: KnowledgeFolder }>(
      `/api/knowledge-bases/${kbId}/folders/${folderId}`,
      { name }
    )
    return res.data
  },

  async deleteFolder(kbId: string, folderId: string): Promise<void> {
    await restClient.delete(`/api/knowledge-bases/${kbId}/folders/${folderId}`)
  },

  // --------------------------------------------------------------------------
  // Files
  // --------------------------------------------------------------------------

  async listFiles(kbId: string, options?: {
    folderId?: string | null
    tags?: string[]
    search?: string
    page?: number
    pageSize?: number
    sortBy?: string
    sortOrder?: string
  }): Promise<PaginatedFiles> {
    const params = new URLSearchParams()
    if (options?.folderId !== undefined) {
      params.set('folder_id', options.folderId === null ? 'root' : options.folderId)
    }
    if (options?.tags?.length) params.set('tags', options.tags.join(','))
    if (options?.search) params.set('search', options.search)
    if (options?.page) params.set('page', String(options.page))
    if (options?.pageSize) params.set('page_size', String(options.pageSize))
    if (options?.sortBy) params.set('sort_by', options.sortBy)
    if (options?.sortOrder) params.set('sort_order', options.sortOrder)

    const query = params.toString()
    const res = await restClient.get<{ data: PaginatedFiles }>(
      `/api/knowledge-bases/${kbId}/files${query ? `?${query}` : ''}`
    )
    return res.data
  },

  async updateFile(kbId: string, fileId: string, data: {
    display_name?: string
    folder_id?: string | null
    tags?: string[]
    is_starred?: boolean
  }): Promise<KnowledgeFile> {
    const res = await restClient.put<{ data: KnowledgeFile }>(
      `/api/knowledge-bases/${kbId}/files/${fileId}`,
      data
    )
    return res.data
  },

  async deleteFile(kbId: string, fileId: string): Promise<void> {
    await restClient.delete(`/api/knowledge-bases/${kbId}/files/${fileId}`)
  },

  async batchOperation(kbId: string, action: 'move' | 'delete' | 'add_tags', fileIds: string[], options?: {
    folderId?: string | null
    tags?: string[]
  }): Promise<void> {
    await restClient.post(`/api/knowledge-bases/${kbId}/files/batch`, {
      action,
      file_ids: fileIds,
      folder_id: options?.folderId,
      tags: options?.tags,
    })
  },

  // --------------------------------------------------------------------------
  // Tags
  // --------------------------------------------------------------------------

  async getTags(kbId: string): Promise<KnowledgeTag[]> {
    const res = await restClient.get<{ data: KnowledgeTag[] }>(`/api/knowledge-bases/${kbId}/tags`)
    return res.data
  },
}
