ALTER TABLE "model_providers"
ADD COLUMN "allowed_model_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "model_providers"
SET "allowed_model_ids" = ARRAY["default_model_id"]
WHERE "default_model_id" IS NOT NULL
  AND BTRIM("default_model_id") <> '';
