/**
 * RAG Retriever Service
 *
 * Semantic search over document chunks. Supports two paths:
 * 1. New: scope → knowledge_bases → document_groups → chunks
 * 2. Legacy: scope → scope_document_groups → chunks
 *
 * Uses pgvector cosine similarity (HNSW index).
 */

import { prisma } from '../../config/database.js';
import { embedText } from '../bedrock-embedder.js';

export interface RAGResult {
  chunkId: string;
  filename: string;
  content: string;
  similarity: number;
  chunkIndex: number;
  tokenCount: number;
  metadata: Record<string, unknown>;
}

export class RagRetrieverService {
  /**
   * Search document chunks relevant to a query, scoped to a business scope.
   * Tries new knowledge_base path first, falls back to legacy scope_document_groups.
   */
  async retrieve(
    query: string,
    scopeId: string,
    topK = 5,
    minSimilarity = 0.5,
  ): Promise<RAGResult[]> {
    // Try new path first: scope → knowledge_bases → document_groups
    const kbBindings = await prisma.scope_knowledge_bindings.findMany({
      where: { scope_id: scopeId },
      select: { knowledge_base_id: true },
    });

    if (kbBindings.length > 0) {
      const kbIds = kbBindings.map(b => b.knowledge_base_id);
      return this.retrieveByKnowledgeBases(query, kbIds, topK, minSimilarity);
    }

    // Fallback: legacy path via scope_document_groups
    const assignments = await prisma.scope_document_groups.findMany({
      where: { business_scope_id: scopeId },
      select: { document_group_id: true },
    });

    if (assignments.length === 0) return [];

    const groupIds = assignments.map(a => a.document_group_id);
    return this.retrieveByDocumentGroups(query, groupIds, topK, minSimilarity);
  }

  /**
   * Search by knowledge base IDs directly (decoupled from scope).
   * Used when the caller already knows which knowledge bases to search.
   */
  async retrieveByKnowledgeBases(
    query: string,
    knowledgeBaseIds: string[],
    topK = 5,
    minSimilarity = 0.5,
  ): Promise<RAGResult[]> {
    if (knowledgeBaseIds.length === 0) return [];

    // Get document_group_ids via knowledge_base_document_groups
    const bindings = await prisma.knowledge_base_document_groups.findMany({
      where: { knowledge_base_id: { in: knowledgeBaseIds } },
      select: { document_group_id: true },
    });

    if (bindings.length === 0) return [];
    const groupIds = [...new Set(bindings.map(b => b.document_group_id))];

    return this.retrieveByDocumentGroups(query, groupIds, topK, minSimilarity);
  }

  /**
   * Core vector search over document_chunks filtered by document group IDs.
   */
  private async retrieveByDocumentGroups(
    query: string,
    groupIds: string[],
    topK: number,
    minSimilarity: number,
  ): Promise<RAGResult[]> {
    if (groupIds.length === 0) return [];

    // Embed the query
    const embedding = await embedText(query);
    const vecLiteral = `[${embedding.join(',')}]`;

    // Build placeholders for group IDs: $4, $5, $6, ...
    const placeholders = groupIds.map((_, i) => `$${i + 4}`).join(', ');

    const results = await prisma.$queryRawUnsafe<Array<{
      id: string;
      content: string;
      chunk_index: number;
      token_count: number;
      metadata: Record<string, unknown>;
      similarity: number;
    }>>(
      `SELECT dc.id, dc.content, dc.chunk_index, dc.token_count, dc.metadata,
              1 - (dc.embedding <=> $1::vector) AS similarity
       FROM document_chunks dc
       WHERE dc.document_group_id IN (${placeholders})
         AND dc.embedding IS NOT NULL
         AND 1 - (dc.embedding <=> $1::vector) > $2
       ORDER BY similarity DESC
       LIMIT $3`,
      vecLiteral,
      minSimilarity,
      topK,
      ...groupIds,
    );

    return results.map(r => ({
      chunkId: r.id,
      filename: (r.metadata?.filename as string) ?? 'unknown',
      content: r.content,
      similarity: r.similarity,
      chunkIndex: r.chunk_index,
      tokenCount: r.token_count,
      metadata: r.metadata,
    }));
  }
}

export const ragRetrieverService = new RagRetrieverService();
