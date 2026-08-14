-- CreateTable: audit_logs
-- Enterprise compliance audit trail (SOC 2, GDPR, 等保)

CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "actor_email" TEXT,
    "action" VARCHAR(100) NOT NULL,
    "resource_type" VARCHAR(50) NOT NULL,
    "resource_id" UUID,
    "resource_name" TEXT,
    "scope_id" UUID,
    "metadata" JSONB,
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- Indexes for efficient querying
CREATE INDEX "audit_logs_organization_id_idx" ON "audit_logs"("organization_id");
CREATE INDEX "audit_logs_actor_id_idx" ON "audit_logs"("actor_id");
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");
CREATE INDEX "audit_logs_resource_type_idx" ON "audit_logs"("resource_type");
CREATE INDEX "audit_logs_scope_id_idx" ON "audit_logs"("scope_id");
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at" DESC);
CREATE INDEX "audit_logs_org_created_idx" ON "audit_logs"("organization_id", "created_at" DESC);
CREATE INDEX "audit_logs_org_action_idx" ON "audit_logs"("organization_id", "action");
CREATE INDEX "audit_logs_org_actor_created_idx" ON "audit_logs"("organization_id", "actor_id", "created_at" DESC);

-- Foreign key
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
