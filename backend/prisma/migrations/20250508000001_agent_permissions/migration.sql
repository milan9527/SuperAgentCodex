-- Agent Permissions: agent-level access control
-- Adds ownership tracking and fine-grained permissions for agents

-- Add created_by and visibility columns to agents table
ALTER TABLE "agents" ADD COLUMN "created_by" UUID;
ALTER TABLE "agents" ADD COLUMN "visibility" VARCHAR(20) NOT NULL DEFAULT 'scope_default';

-- Create index on created_by for ownership lookups
CREATE INDEX "agents_created_by_idx" ON "agents"("created_by");

-- Create agent_permissions table
CREATE TABLE "agent_permissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "permission" VARCHAR(20) NOT NULL DEFAULT 'invoke',
    "granted_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "agent_permissions_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: one permission per user per agent
ALTER TABLE "agent_permissions" ADD CONSTRAINT "unique_agent_user_permission" UNIQUE ("agent_id", "user_id");

-- Foreign keys
ALTER TABLE "agent_permissions" ADD CONSTRAINT "agent_permissions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_permissions" ADD CONSTRAINT "agent_permissions_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Indexes for common query patterns
CREATE INDEX "agent_permissions_agent_id_idx" ON "agent_permissions"("agent_id");
CREATE INDEX "agent_permissions_user_id_idx" ON "agent_permissions"("user_id");
CREATE INDEX "agent_permissions_organization_id_idx" ON "agent_permissions"("organization_id");
CREATE INDEX "agent_permissions_agent_id_user_id_idx" ON "agent_permissions"("agent_id", "user_id");
