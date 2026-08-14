/**
 * Knowledge Base Service
 *
 * CRUD operations for knowledge bases, folders, files, and scope bindings.
 * Knowledge bases are independent first-class resources that can be bound
 * to multiple scopes.
 */

import { prisma } from '../config/database.js';

// ============================================================================
// Types
// ============================================================================

export interface CreateKnowledgeBaseInput {
  organizationId: string;
  name: string;
  description?: string;
  icon?: string;
  createdBy?: string;
}

export interface UpdateKnowledgeBaseInput {
  name?: string;
  description?: string;
  icon?: string;
}

export interface CreateFolderInput {
  organizationId: string;
  knowledgeBaseId: string;
  parentId?: string;
  name: string;
  createdBy?: string;
}

export interface ListFilesOptions {
  knowledgeBaseId: string;
  folderId?: string | null;
  tags?: string[];
  search?: string;
  page?: number;
  pageSize?: number;
  sortBy?: 'created_at' | 'display_name' | 'file_size';
  sortOrder?: 'asc' | 'desc';
}

// ============================================================================
// Service
// ============================================================================

export class KnowledgeBaseService {
  // --------------------------------------------------------------------------
  // Knowledge Base CRUD
  // --------------------------------------------------------------------------

  async create(input: CreateKnowledgeBaseInput) {
    return prisma.knowledge_bases.create({
      data: {
        organization_id: input.organizationId,
        name: input.name,
        description: input.description,
        icon: input.icon || '📚',
        created_by: input.createdBy,
      },
    });
  }

  async findById(id: string) {
    return prisma.knowledge_bases.findUnique({ where: { id } });
  }

  async listByOrganization(organizationId: string) {
    return prisma.knowledge_bases.findMany({
      where: { organization_id: organizationId, status: 'active' },
      orderBy: { created_at: 'desc' },
    });
  }

  async update(id: string, input: UpdateKnowledgeBaseInput) {
    return prisma.knowledge_bases.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.icon !== undefined && { icon: input.icon }),
      },
    });
  }

  async delete(id: string) {
    // Soft delete by setting status to 'deleted'
    return prisma.knowledge_bases.update({
      where: { id },
      data: { status: 'deleted' },
    });
  }

  // --------------------------------------------------------------------------
  // Scope Bindings
  // --------------------------------------------------------------------------

  async bindToScope(scopeId: string, knowledgeBaseId: string, boundBy?: string) {
    return prisma.scope_knowledge_bindings.create({
      data: {
        scope_id: scopeId,
        knowledge_base_id: knowledgeBaseId,
        bound_by: boundBy,
      },
    });
  }

  async unbindFromScope(scopeId: string, knowledgeBaseId: string) {
    return prisma.scope_knowledge_bindings.deleteMany({
      where: { scope_id: scopeId, knowledge_base_id: knowledgeBaseId },
    });
  }

  async getScopeBindings(scopeId: string) {
    return prisma.scope_knowledge_bindings.findMany({
      where: { scope_id: scopeId },
      include: { knowledge_base: true },
    });
  }

  async getKnowledgeBaseIdsForScope(scopeId: string): Promise<string[]> {
    const bindings = await prisma.scope_knowledge_bindings.findMany({
      where: { scope_id: scopeId },
      select: { knowledge_base_id: true },
    });
    return bindings.map(b => b.knowledge_base_id);
  }

  // --------------------------------------------------------------------------
  // Document Group Bindings (link knowledge base to underlying doc groups)
  // --------------------------------------------------------------------------

  async addDocumentGroup(knowledgeBaseId: string, documentGroupId: string) {
    return prisma.knowledge_base_document_groups.create({
      data: {
        knowledge_base_id: knowledgeBaseId,
        document_group_id: documentGroupId,
      },
    });
  }

  async removeDocumentGroup(knowledgeBaseId: string, documentGroupId: string) {
    return prisma.knowledge_base_document_groups.deleteMany({
      where: { knowledge_base_id: knowledgeBaseId, document_group_id: documentGroupId },
    });
  }

  async getDocumentGroups(knowledgeBaseId: string) {
    return prisma.knowledge_base_document_groups.findMany({
      where: { knowledge_base_id: knowledgeBaseId },
      include: { document_group: true },
    });
  }

  // --------------------------------------------------------------------------
  // Folders
  // --------------------------------------------------------------------------

  async createFolder(input: CreateFolderInput) {
    // Build path from parent
    let path = '/';
    if (input.parentId) {
      const parent = await prisma.knowledge_folders.findUnique({
        where: { id: input.parentId },
      });
      if (parent) {
        path = parent.path === '/' ? `/${input.name}` : `${parent.path}/${input.name}`;
      }
    } else {
      path = `/${input.name}`;
    }

    return prisma.knowledge_folders.create({
      data: {
        organization_id: input.organizationId,
        knowledge_base_id: input.knowledgeBaseId,
        parent_id: input.parentId,
        name: input.name,
        path,
        created_by: input.createdBy,
      },
    });
  }

  async listFolders(knowledgeBaseId: string, parentId?: string | null) {
    return prisma.knowledge_folders.findMany({
      where: {
        knowledge_base_id: knowledgeBaseId,
        parent_id: parentId ?? null,
      },
      orderBy: { name: 'asc' },
    });
  }

  async renameFolder(folderId: string, newName: string) {
    const folder = await prisma.knowledge_folders.findUnique({ where: { id: folderId } });
    if (!folder) throw new Error('Folder not found');

    // Update path
    const pathParts = folder.path.split('/');
    pathParts[pathParts.length - 1] = newName;
    const newPath = pathParts.join('/');

    return prisma.knowledge_folders.update({
      where: { id: folderId },
      data: { name: newName, path: newPath },
    });
  }

  async deleteFolder(folderId: string) {
    // Cascade delete handles children and file references (SET NULL)
    return prisma.knowledge_folders.delete({ where: { id: folderId } });
  }

  // --------------------------------------------------------------------------
  // Files
  // --------------------------------------------------------------------------

  async listFiles(options: ListFilesOptions) {
    const {
      knowledgeBaseId,
      folderId,
      tags,
      search,
      page = 1,
      pageSize = 50,
      sortBy = 'created_at',
      sortOrder = 'desc',
    } = options;

    const where: any = { knowledge_base_id: knowledgeBaseId };

    // Folder filter: null means root, undefined means all
    if (folderId !== undefined) {
      where.folder_id = folderId;
    }

    if (tags && tags.length > 0) {
      where.tags = { hasSome: tags };
    }

    if (search) {
      where.OR = [
        { display_name: { contains: search, mode: 'insensitive' } },
        { original_filename: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.knowledge_files.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.knowledge_files.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    };
  }

  async getFile(fileId: string) {
    return prisma.knowledge_files.findUnique({ where: { id: fileId } });
  }

  async updateFile(fileId: string, data: {
    displayName?: string;
    folderId?: string | null;
    tags?: string[];
    isStarred?: boolean;
  }) {
    return prisma.knowledge_files.update({
      where: { id: fileId },
      data: {
        ...(data.displayName !== undefined && { display_name: data.displayName }),
        ...(data.folderId !== undefined && { folder_id: data.folderId }),
        ...(data.tags !== undefined && { tags: data.tags }),
        ...(data.isStarred !== undefined && { is_starred: data.isStarred }),
      },
    });
  }

  async deleteFile(fileId: string) {
    return prisma.knowledge_files.delete({ where: { id: fileId } });
  }

  async batchMoveFiles(fileIds: string[], folderId: string | null) {
    return prisma.knowledge_files.updateMany({
      where: { id: { in: fileIds } },
      data: { folder_id: folderId },
    });
  }

  async batchDeleteFiles(fileIds: string[]) {
    return prisma.knowledge_files.deleteMany({
      where: { id: { in: fileIds } },
    });
  }

  async batchAddTags(fileIds: string[], tags: string[]) {
    // Prisma doesn't support array append in updateMany, so we do it per-file
    const files = await prisma.knowledge_files.findMany({
      where: { id: { in: fileIds } },
      select: { id: true, tags: true },
    });

    const updates = files.map(f => {
      const merged = [...new Set([...f.tags, ...tags])];
      return prisma.knowledge_files.update({
        where: { id: f.id },
        data: { tags: merged },
      });
    });

    return prisma.$transaction(updates);
  }

  // --------------------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------------------

  async updateStats(knowledgeBaseId: string) {
    const stats = await prisma.knowledge_files.aggregate({
      where: { knowledge_base_id: knowledgeBaseId },
      _count: true,
      _sum: { file_size: true },
    });

    return prisma.knowledge_bases.update({
      where: { id: knowledgeBaseId },
      data: {
        document_count: stats._count,
        total_size: stats._sum.file_size ?? 0,
      },
    });
  }

  async getTags(knowledgeBaseId: string): Promise<{ tag: string; count: number }[]> {
    // Use raw query for array aggregation
    const results = await prisma.$queryRawUnsafe<Array<{ tag: string; count: bigint }>>(
      `SELECT unnest(tags) as tag, COUNT(*) as count
       FROM knowledge_files
       WHERE knowledge_base_id = $1
       GROUP BY tag
       ORDER BY count DESC`,
      knowledgeBaseId,
    );

    return results.map(r => ({ tag: r.tag, count: Number(r.count) }));
  }
}

export const knowledgeBaseService = new KnowledgeBaseService();
