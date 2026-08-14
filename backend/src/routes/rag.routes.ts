/**
 * RAG Routes
 *
 * Semantic search over document chunks + indexing management.
 * All routes require authentication.
 *
 * Supports two query modes:
 *   1. ?scope_id=xxx — searches via scope's bound knowledge bases (or legacy doc groups)
 *   2. ?knowledge_base_ids=id1,id2 — searches specific knowledge bases directly
 */

import { FastifyInstance } from 'fastify';
import { authenticate, requireModifyAccess } from '../middleware/auth.js';
import { ragRetrieverService } from '../services/rag/rag-retriever.service.js';
import { documentIndexerService, isRagEnabled } from '../services/rag/document-indexer.service.js';

export async function ragRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /api/rag/search — semantic search over document chunks */
  fastify.get<{
    Querystring: {
      scope_id?: string;
      knowledge_base_ids?: string;
      q: string;
      top_k?: string;
      min_similarity?: string;
    };
  }>(
    '/search',
    { preHandler: [authenticate] },
    async (request, reply) => {
      if (!isRagEnabled()) {
        return reply.status(400).send({ error: 'RAG is not enabled', code: 'RAG_DISABLED' });
      }

      const { scope_id, knowledge_base_ids, q, top_k, min_similarity } = request.query;
      if (!q) {
        return reply.status(400).send({ error: 'q (query) is required', code: 'VALIDATION_ERROR' });
      }

      const topK = top_k ? parseInt(top_k, 10) : 5;
      const minSim = min_similarity ? parseFloat(min_similarity) : 0.5;

      // Path 1: Direct knowledge base IDs
      if (knowledge_base_ids) {
        const ids = knowledge_base_ids.split(',').map(id => id.trim()).filter(Boolean);
        if (ids.length === 0) {
          return reply.status(400).send({ error: 'knowledge_base_ids must contain at least one ID', code: 'VALIDATION_ERROR' });
        }
        const results = await ragRetrieverService.retrieveByKnowledgeBases(q, ids, topK, minSim);
        return reply.send({ data: results });
      }

      // Path 2: Scope-based (tries knowledge bases first, falls back to legacy)
      if (scope_id) {
        const results = await ragRetrieverService.retrieve(q, scope_id, topK, minSim);
        return reply.send({ data: results });
      }

      return reply.status(400).send({
        error: 'Either scope_id or knowledge_base_ids is required',
        code: 'VALIDATION_ERROR',
      });
    },
  );

  /** POST /api/rag/index/:fileId — manually index a single file */
  fastify.post<{ Params: { fileId: string }; Body: { document_group_id: string; storage_path: string; stored_filename: string; mime_type: string; original_filename: string } }>(
    '/index/:fileId',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      if (!isRagEnabled()) {
        return reply.status(400).send({ error: 'RAG is not enabled', code: 'RAG_DISABLED' });
      }

      const { document_group_id, storage_path, stored_filename, mime_type, original_filename } = request.body;
      const count = await documentIndexerService.indexFile(
        request.params.fileId,
        request.user!.orgId,
        document_group_id,
        storage_path,
        stored_filename,
        mime_type,
        original_filename,
      );

      return reply.send({ data: { indexed_chunks: count } });
    },
  );

  /** POST /api/rag/index-group/:groupId — index all files in a document group */
  fastify.post<{ Params: { groupId: string } }>(
    '/index-group/:groupId',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      if (!isRagEnabled()) {
        return reply.status(400).send({ error: 'RAG is not enabled', code: 'RAG_DISABLED' });
      }

      const count = await documentIndexerService.indexGroup(
        request.params.groupId,
        request.user!.orgId,
      );

      return reply.send({ data: { indexed_chunks: count } });
    },
  );

  /** GET /api/rag/status/:groupId — indexing status for a document group */
  fastify.get<{ Params: { groupId: string } }>(
    '/status/:groupId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const status = await documentIndexerService.getGroupStatus(
        request.params.groupId,
        request.user!.orgId,
      );
      return reply.send({ data: { ...status, rag_enabled: isRagEnabled() } });
    },
  );

  /** DELETE /api/rag/index/:fileId — delete index for a file */
  fastify.delete<{ Params: { fileId: string } }>(
    '/index/:fileId',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      await documentIndexerService.deleteFileIndex(request.params.fileId);
      return reply.status(204).send();
    },
  );
}
