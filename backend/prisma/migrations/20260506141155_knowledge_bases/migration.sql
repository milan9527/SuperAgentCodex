-- Knowledge Bases — independent first-class knowledge resources
-- Decoupled from scopes; scopes bind to knowledge bases via scope_knowledge_bindings.

-- 1. Knowledge Bases table
CREATE TABLE "knowledge_bases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" VARCHAR(1000),
    "icon" VARCHAR(10),
    "status" VARCHAR(50) NOT NULL DEFAULT 'active',
    "document_count" INT NOT NULL DEFAULT 0,
    "total_size" BIGINT NOT NULL DEFAULT 0,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "knowledge_bases_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_bases_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "unique_kb_name_per_org" ON "knowledge_bases"("organization_id", "name");
CREATE INDEX "knowledge_bases_organization_id_idx" ON "knowledge_bases"("organization_id");
CREATE INDEX "knowledge_bases_status_idx" ON "knowledge_bases"("status");
CREATE INDEX "knowledge_bases_created_at_idx" ON "knowledge_bases"("created_at" DESC);

-- 2. Scope ↔ Knowledge Base bindings (many-to-many)
CREATE TABLE "scope_knowledge_bindings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scope_id" UUID NOT NULL,
    "knowledge_base_id" UUID NOT NULL,
    "bound_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "scope_knowledge_bindings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "scope_knowledge_bindings_scope_id_fkey"
        FOREIGN KEY ("scope_id") REFERENCES "business_scopes"("id") ON DELETE CASCADE,
    CONSTRAINT "scope_knowledge_bindings_knowledge_base_id_fkey"
        FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "unique_scope_kb_binding" ON "scope_knowledge_bindings"("scope_id", "knowledge_base_id");
CREATE INDEX "scope_knowledge_bindings_scope_id_idx" ON "scope_knowledge_bindings"("scope_id");
CREATE INDEX "scope_knowledge_bindings_knowledge_base_id_idx" ON "scope_knowledge_bindings"("knowledge_base_id");

-- 3. Knowledge Base ↔ Document Group bindings
CREATE TABLE "knowledge_base_document_groups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "knowledge_base_id" UUID NOT NULL,
    "document_group_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "knowledge_base_document_groups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "kb_doc_groups_knowledge_base_id_fkey"
        FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE,
    CONSTRAINT "kb_doc_groups_document_group_id_fkey"
        FOREIGN KEY ("document_group_id") REFERENCES "document_groups"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "unique_kb_doc_group" ON "knowledge_base_document_groups"("knowledge_base_id", "document_group_id");
CREATE INDEX "kb_doc_groups_knowledge_base_id_idx" ON "knowledge_base_document_groups"("knowledge_base_id");
CREATE INDEX "kb_doc_groups_document_group_id_idx" ON "knowledge_base_document_groups"("document_group_id");

-- 4. Knowledge Folders — user-defined folder structure
CREATE TABLE "knowledge_folders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "knowledge_base_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" VARCHAR(255) NOT NULL,
    "path" VARCHAR(1024) NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "knowledge_folders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_folders_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "knowledge_folders_knowledge_base_id_fkey"
        FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE,
    CONSTRAINT "knowledge_folders_parent_id_fkey"
        FOREIGN KEY ("parent_id") REFERENCES "knowledge_folders"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "unique_folder_path_per_kb" ON "knowledge_folders"("knowledge_base_id", "path");
CREATE INDEX "knowledge_folders_organization_id_idx" ON "knowledge_folders"("organization_id");
CREATE INDEX "knowledge_folders_knowledge_base_id_idx" ON "knowledge_folders"("knowledge_base_id");
CREATE INDEX "knowledge_folders_parent_id_idx" ON "knowledge_folders"("parent_id");

-- 5. Knowledge Files — file metadata
CREATE TABLE "knowledge_files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "knowledge_base_id" UUID NOT NULL,
    "folder_id" UUID,
    "display_name" VARCHAR(255) NOT NULL,
    "original_filename" VARCHAR(255) NOT NULL,
    "stored_filename" VARCHAR(255) NOT NULL,
    "s3_key" VARCHAR(512) NOT NULL,
    "file_size" BIGINT NOT NULL DEFAULT 0,
    "mime_type" VARCHAR(100) NOT NULL DEFAULT 'application/octet-stream',
    "tags" TEXT[] DEFAULT '{}',
    "is_starred" BOOLEAN NOT NULL DEFAULT false,
    "index_status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "version" INT NOT NULL DEFAULT 1,
    "uploaded_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "knowledge_files_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_files_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "knowledge_files_knowledge_base_id_fkey"
        FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE,
    CONSTRAINT "knowledge_files_folder_id_fkey"
        FOREIGN KEY ("folder_id") REFERENCES "knowledge_folders"("id") ON DELETE SET NULL
);

CREATE INDEX "knowledge_files_organization_id_idx" ON "knowledge_files"("organization_id");
CREATE INDEX "knowledge_files_knowledge_base_id_idx" ON "knowledge_files"("knowledge_base_id");
CREATE INDEX "knowledge_files_folder_id_idx" ON "knowledge_files"("folder_id");
CREATE INDEX "knowledge_files_index_status_idx" ON "knowledge_files"("index_status");
CREATE INDEX "knowledge_files_kb_folder_idx" ON "knowledge_files"("knowledge_base_id", "folder_id");
CREATE INDEX "knowledge_files_created_at_idx" ON "knowledge_files"("created_at" DESC);
