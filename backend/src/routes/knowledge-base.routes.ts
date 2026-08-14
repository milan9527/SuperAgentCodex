/**
 * Knowledge Base Routes
 *
 * CRUD for knowledge bases, folders, files, and scope bindings.
 * All routes require authentication.
 */

import { FastifyInstance } from 'fastify';
import { authenticate, requireModifyAccess } from '../middleware/auth.js';
import { knowledgeBaseService } from '../services/knowledge-base.service.js';

/** Convert BigInt fields to Number for JSON serialization */
function serializeKb(kb: any) {
  if (!kb) return kb;
  return { ...kb, total_size: Number(kb.total_size ?? 0) };
}
function serializeKbs(kbs: any[]) {
  return kbs.map(serializeKb);
}
function serializeFile(f: any) {
  if (!f) return f;
  return { ...f, file_size: Number(f.file_size ?? 0) };
}

export async function knowledgeBaseRoutes(fastify: FastifyInstance): Promise<void> {
  // ==========================================================================
  // Knowledge Base CRUD
  // ==========================================================================

  /** GET /api/knowledge-bases — list all knowledge bases for the org */
  fastify.get('/', { preHandler: [authenticate] }, async (request, reply) => {
    const kbs = await knowledgeBaseService.listByOrganization(request.user!.orgId);
    return reply.send({ data: serializeKbs(kbs) });
  });

  /** POST /api/knowledge-bases — create a new knowledge base */
  fastify.post<{ Body: { name: string; description?: string; icon?: string } }>(
    '/',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      const { name, description, icon } = request.body;
      if (!name?.trim()) {
        return reply.status(400).send({ error: 'name is required', code: 'VALIDATION_ERROR' });
      }

      const kb = await knowledgeBaseService.create({
        organizationId: request.user!.orgId,
        name: name.trim(),
        description,
        icon,
        createdBy: request.user!.id,
      });

      return reply.status(201).send({ data: serializeKb(kb) });
    },
  );

  /** GET /api/knowledge-bases/:id — get a single knowledge base */
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const kb = await knowledgeBaseService.findById(request.params.id);
      if (!kb) return reply.status(404).send({ error: 'Knowledge base not found' });
      return reply.send({ data: serializeKb(kb) });
    },
  );

  /** PUT /api/knowledge-bases/:id — update a knowledge base */
  fastify.put<{ Params: { id: string }; Body: { name?: string; description?: string; icon?: string } }>(
    '/:id',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      const kb = await knowledgeBaseService.update(request.params.id, request.body);
      return reply.send({ data: serializeKb(kb) });
    },
  );

  /** DELETE /api/knowledge-bases/:id — soft-delete a knowledge base */
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      await knowledgeBaseService.delete(request.params.id);
      return reply.status(204).send();
    },
  );

  // ==========================================================================
  // Scope Bindings
  // ==========================================================================

  /** GET /api/knowledge-bases/scope/:scopeId/bindings — get bindings for a scope */
  fastify.get<{ Params: { scopeId: string } }>(
    '/scope/:scopeId/bindings',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const bindings = await knowledgeBaseService.getScopeBindings(request.params.scopeId);
      // Serialize nested knowledge_base BigInt fields
      const serialized = bindings.map((b: any) => ({
        ...b,
        knowledge_base: b.knowledge_base ? serializeKb(b.knowledge_base) : b.knowledge_base,
      }));
      return reply.send({ data: serialized });
    },
  );

  /** POST /api/knowledge-bases/scope/:scopeId/bind — bind a knowledge base to a scope */
  fastify.post<{ Params: { scopeId: string }; Body: { knowledge_base_id: string } }>(
    '/scope/:scopeId/bind',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      const { knowledge_base_id } = request.body;
      if (!knowledge_base_id) {
        return reply.status(400).send({ error: 'knowledge_base_id is required', code: 'VALIDATION_ERROR' });
      }

      const binding = await knowledgeBaseService.bindToScope(
        request.params.scopeId,
        knowledge_base_id,
        request.user!.id,
      );
      return reply.status(201).send({ data: binding });
    },
  );

  /** DELETE /api/knowledge-bases/scope/:scopeId/unbind/:kbId — unbind */
  fastify.delete<{ Params: { scopeId: string; kbId: string } }>(
    '/scope/:scopeId/unbind/:kbId',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      await knowledgeBaseService.unbindFromScope(request.params.scopeId, request.params.kbId);
      return reply.status(204).send();
    },
  );

  // ==========================================================================
  // Folders
  // ==========================================================================

  /** GET /api/knowledge-bases/:id/folders — list folders (optionally by parent) */
  fastify.get<{ Params: { id: string }; Querystring: { parent_id?: string } }>(
    '/:id/folders',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const parentId = request.query.parent_id || null;
      const folders = await knowledgeBaseService.listFolders(request.params.id, parentId);
      return reply.send({ data: folders });
    },
  );

  /** POST /api/knowledge-bases/:id/folders — create a folder */
  fastify.post<{ Params: { id: string }; Body: { name: string; parent_id?: string } }>(
    '/:id/folders',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      const { name, parent_id } = request.body;
      if (!name?.trim()) {
        return reply.status(400).send({ error: 'name is required', code: 'VALIDATION_ERROR' });
      }

      const folder = await knowledgeBaseService.createFolder({
        organizationId: request.user!.orgId,
        knowledgeBaseId: request.params.id,
        parentId: parent_id,
        name: name.trim(),
        createdBy: request.user!.id,
      });

      return reply.status(201).send({ data: folder });
    },
  );

  /** PUT /api/knowledge-bases/:id/folders/:folderId — rename a folder */
  fastify.put<{ Params: { id: string; folderId: string }; Body: { name: string } }>(
    '/:id/folders/:folderId',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      const { name } = request.body;
      if (!name?.trim()) {
        return reply.status(400).send({ error: 'name is required', code: 'VALIDATION_ERROR' });
      }
      const folder = await knowledgeBaseService.renameFolder(request.params.folderId, name.trim());
      return reply.send({ data: folder });
    },
  );

  /** DELETE /api/knowledge-bases/:id/folders/:folderId — delete a folder */
  fastify.delete<{ Params: { id: string; folderId: string } }>(
    '/:id/folders/:folderId',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      await knowledgeBaseService.deleteFolder(request.params.folderId);
      return reply.status(204).send();
    },
  );

  // ==========================================================================
  // Files
  // ==========================================================================

  /** POST /api/knowledge-bases/:id/files/upload — upload file (multipart) */
  fastify.post<{ Params: { id: string } }>(
    '/:id/files/upload',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      const kb = await knowledgeBaseService.findById(request.params.id);
      if (!kb) return reply.status(404).send({ error: 'Knowledge base not found' });

      const file = await request.file({ limits: { fileSize: 50 * 1024 * 1024 } });
      if (!file) return reply.status(400).send({ error: 'No file uploaded' });

      const buffer = await file.toBuffer();
      const storedFilename = `${Date.now()}-${file.filename.replace(/[/\\:*?"<>|]/g, '-')}`;
      const s3Key = `knowledge-bases/${kb.id}/${storedFilename}`;

      // Upload to S3
      const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
      const { config: appConfig } = await import('../config/index.js');
      const s3 = new S3Client({ region: appConfig.aws.region });
      await s3.send(new PutObjectCommand({
        Bucket: appConfig.s3.bucketName,
        Key: s3Key,
        Body: buffer,
        ContentType: file.mimetype || 'application/octet-stream',
      }));

      // Also write to local disk for RAG indexing (document-indexer reads from disk)
      const { mkdir, writeFile } = await import('fs/promises');
      const { join } = await import('path');
      const localDir = join(appConfig.docGroups.basePath, 'kb', kb.id);
      await mkdir(localDir, { recursive: true });
      const localPath = join(localDir, storedFilename);
      await writeFile(localPath, buffer);

      // Parse folder_id from query if provided
      const folderId = (request.query as any)?.folder_id || null;

      // Create file record
      const { prisma } = await import('../config/database.js');
      const fileRecord = await prisma.knowledge_files.create({
        data: {
          organization_id: request.user!.orgId,
          knowledge_base_id: kb.id,
          folder_id: folderId,
          display_name: file.filename.replace(/\.[^.]+$/, ''),
          original_filename: file.filename,
          stored_filename: storedFilename,
          s3_key: s3Key,
          file_size: BigInt(buffer.length),
          mime_type: file.mimetype || 'application/octet-stream',
          index_status: 'pending',
          uploaded_by: request.user!.id,
        },
      });

      // Update KB stats
      await knowledgeBaseService.updateStats(kb.id);

      // Auto-index for RAG (fire-and-forget)
      const { documentIndexerService, isRagEnabled } = await import('../services/rag/document-indexer.service.js');
      if (isRagEnabled()) {
        // Ensure a document_group exists for this KB (create if needed)
        let kbDocGroup = await prisma.knowledge_base_document_groups.findFirst({
          where: { knowledge_base_id: kb.id },
          include: { document_group: true },
        });

        if (!kbDocGroup) {
          // Create a document_group for this KB
          const docGroup = await prisma.document_groups.create({
            data: {
              organization_id: request.user!.orgId,
              name: `kb-${kb.id}`,
              description: `Auto-created for knowledge base: ${kb.name}`,
              storage_path: localDir,
            },
          });
          kbDocGroup = await prisma.knowledge_base_document_groups.create({
            data: {
              knowledge_base_id: kb.id,
              document_group_id: docGroup.id,
            },
            include: { document_group: true },
          }) as any;
        }

        // Create a document_group_files record for the indexer
        const dgFile = await prisma.document_group_files.create({
          data: {
            document_group_id: kbDocGroup!.document_group_id,
            organization_id: request.user!.orgId,
            original_filename: file.filename,
            stored_filename: storedFilename,
            file_size: BigInt(buffer.length),
            mime_type: file.mimetype || 'application/octet-stream',
            uploaded_by: request.user!.id,
          },
        });

        // Index asynchronously
        documentIndexerService.indexFile(
          dgFile.id,
          request.user!.orgId,
          kbDocGroup!.document_group_id,
          localDir,
          storedFilename,
          file.mimetype || 'application/octet-stream',
          file.filename,
        ).then(() => {
          // Update index_status
          prisma.knowledge_files.update({
            where: { id: fileRecord.id },
            data: { index_status: 'indexed' },
          }).catch(() => {});
        }).catch(() => {
          prisma.knowledge_files.update({
            where: { id: fileRecord.id },
            data: { index_status: 'failed' },
          }).catch(() => {});
        });

        // Mark as indexing
        await prisma.knowledge_files.update({
          where: { id: fileRecord.id },
          data: { index_status: 'indexing' },
        });
      }

      return reply.status(201).send({
        data: { ...fileRecord, file_size: Number(fileRecord.file_size) },
      });
    },
  );

  /** GET /api/knowledge-bases/:id/files — list files with pagination */
  fastify.get<{
    Params: { id: string };
    Querystring: {
      folder_id?: string;
      tags?: string;
      search?: string;
      page?: string;
      page_size?: string;
      sort_by?: string;
      sort_order?: string;
    };
  }>(
    '/:id/files',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { folder_id, tags, search, page, page_size, sort_by, sort_order } = request.query;

      const result = await knowledgeBaseService.listFiles({
        knowledgeBaseId: request.params.id,
        folderId: folder_id === 'root' ? null : folder_id,
        tags: tags ? tags.split(',') : undefined,
        search,
        page: page ? parseInt(page, 10) : 1,
        pageSize: page_size ? parseInt(page_size, 10) : 50,
        sortBy: (sort_by as any) || 'created_at',
        sortOrder: (sort_order as any) || 'desc',
      });

      return reply.send({ data: { ...result, items: result.items.map(serializeFile) } });
    },
  );

  /** PUT /api/knowledge-bases/:id/files/:fileId — update file metadata */
  fastify.put<{
    Params: { id: string; fileId: string };
    Body: { display_name?: string; folder_id?: string | null; tags?: string[]; is_starred?: boolean };
  }>(
    '/:id/files/:fileId',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      const { display_name, folder_id, tags, is_starred } = request.body;
      const file = await knowledgeBaseService.updateFile(request.params.fileId, {
        displayName: display_name,
        folderId: folder_id,
        tags,
        isStarred: is_starred,
      });
      return reply.send({ data: serializeFile(file) });
    },
  );

  /** DELETE /api/knowledge-bases/:id/files/:fileId — delete a file */
  fastify.delete<{ Params: { id: string; fileId: string } }>(
    '/:id/files/:fileId',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      await knowledgeBaseService.deleteFile(request.params.fileId);
      // Update stats
      await knowledgeBaseService.updateStats(request.params.id);
      return reply.status(204).send();
    },
  );

  /** POST /api/knowledge-bases/:id/files/batch — batch operations */
  fastify.post<{
    Params: { id: string };
    Body: { action: 'move' | 'delete' | 'add_tags'; file_ids: string[]; folder_id?: string | null; tags?: string[] };
  }>(
    '/:id/files/batch',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      const { action, file_ids, folder_id, tags } = request.body;

      if (!file_ids || file_ids.length === 0) {
        return reply.status(400).send({ error: 'file_ids is required', code: 'VALIDATION_ERROR' });
      }

      switch (action) {
        case 'move':
          await knowledgeBaseService.batchMoveFiles(file_ids, folder_id ?? null);
          break;
        case 'delete':
          await knowledgeBaseService.batchDeleteFiles(file_ids);
          break;
        case 'add_tags':
          if (!tags || tags.length === 0) {
            return reply.status(400).send({ error: 'tags is required for add_tags action', code: 'VALIDATION_ERROR' });
          }
          await knowledgeBaseService.batchAddTags(file_ids, tags);
          break;
        default:
          return reply.status(400).send({ error: `Unknown action: ${action}`, code: 'VALIDATION_ERROR' });
      }

      // Update stats after batch operations
      await knowledgeBaseService.updateStats(request.params.id);
      return reply.send({ data: { success: true, affected: file_ids.length } });
    },
  );

  // ==========================================================================
  // Tags
  // ==========================================================================

  /** GET /api/knowledge-bases/:id/tags — get all tags with counts */
  fastify.get<{ Params: { id: string } }>(
    '/:id/tags',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const tags = await knowledgeBaseService.getTags(request.params.id);
      return reply.send({ data: tags });
    },
  );
}
