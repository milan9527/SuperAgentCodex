-- Add backend_type to published_apps
ALTER TABLE "published_apps" ADD COLUMN "backend_type" VARCHAR(20) NOT NULL DEFAULT 'none';

-- Create app_backend_instances table
CREATE TABLE "app_backend_instances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "app_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_name" VARCHAR(100) NOT NULL,
    "provider" VARCHAR(20) NOT NULL DEFAULT 'insforge',
    "status" VARCHAR(20) NOT NULL DEFAULT 'provisioning',
    "instance_type" VARCHAR(20) NOT NULL DEFAULT 'nano',
    "host" TEXT NOT NULL DEFAULT 'localhost',
    "port_postgres" INTEGER NOT NULL,
    "port_app" INTEGER NOT NULL,
    "port_auth" INTEGER NOT NULL,
    "port_deno" INTEGER NOT NULL,
    "port_postgrest" INTEGER NOT NULL,
    "api_key" TEXT NOT NULL,
    "db_url_enc" TEXT,
    "mcp_endpoint" TEXT,
    "storage_used_mb" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "storage_limit_mb" DOUBLE PRECISION NOT NULL DEFAULT 500,
    "db_size_mb" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "db_limit_mb" DOUBLE PRECISION NOT NULL DEFAULT 500,
    "last_active_at" TIMESTAMPTZ,
    "paused_at" TIMESTAMPTZ,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "app_backend_instances_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: one backend per app
CREATE UNIQUE INDEX "app_backend_instances_app_id_key" ON "app_backend_instances"("app_id");

-- Indexes
CREATE INDEX "app_backend_instances_org_id_idx" ON "app_backend_instances"("org_id");
CREATE INDEX "app_backend_instances_status_idx" ON "app_backend_instances"("status");
CREATE INDEX "app_backend_instances_last_active_at_idx" ON "app_backend_instances"("last_active_at");

-- Foreign keys
ALTER TABLE "app_backend_instances" ADD CONSTRAINT "app_backend_instances_app_id_fkey"
    FOREIGN KEY ("app_id") REFERENCES "published_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "app_backend_instances" ADD CONSTRAINT "app_backend_instances_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
