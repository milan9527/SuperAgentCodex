-- Re-create document_chunks table for RAG semantic search.
-- This table uses pgvector and is NOT managed by Prisma schema (raw SQL only).
-- Requires: CREATE EXTENSION IF NOT EXISTS vector;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "document_chunks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "document_group_id" UUID NOT NULL,
    "knowledge_base_id" UUID,
    "file_id" UUID NOT NULL,
    "chunk_index" INT NOT NULL,
    "content" TEXT NOT NULL,
    "token_count" INT DEFAULT 0,
    "embedding" vector(1024),
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_chunks_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "document_chunks_document_group_id_fkey"
        FOREIGN KEY ("document_group_id") REFERENCES "document_groups"("id") ON DELETE CASCADE
);

-- HNSW index for fast cosine similarity search
CREATE INDEX IF NOT EXISTS "document_chunks_embedding_idx"
    ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops);

-- Lookup indexes
CREATE INDEX IF NOT EXISTS "document_chunks_document_group_id_idx" ON "document_chunks"("document_group_id");
CREATE INDEX IF NOT EXISTS "document_chunks_knowledge_base_id_idx" ON "document_chunks"("knowledge_base_id");
CREATE INDEX IF NOT EXISTS "document_chunks_file_id_idx" ON "document_chunks"("file_id");
CREATE INDEX IF NOT EXISTS "document_chunks_organization_id_idx" ON "document_chunks"("organization_id");
