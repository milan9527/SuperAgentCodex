-- Reusable per-org LLM provider configs (Bedrock or LiteLLM gateway).
CREATE TABLE "model_providers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "base_url" VARCHAR(1024),
    "credential_id" UUID,
    "default_model_id" VARCHAR(255),
    "is_org_default" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(50) NOT NULL DEFAULT 'active',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_providers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "model_providers_organization_id_name_key" ON "model_providers"("organization_id", "name");
CREATE INDEX "model_providers_organization_id_idx" ON "model_providers"("organization_id");
CREATE INDEX "model_providers_status_idx" ON "model_providers"("status");

ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed a default Bedrock provider for every existing organization so model
-- resolution has a fallback and nothing regresses.
INSERT INTO "model_providers" ("id", "organization_id", "name", "type", "is_org_default")
SELECT gen_random_uuid(), o."id", 'Amazon Bedrock', 'bedrock', true
FROM "organizations" o;
