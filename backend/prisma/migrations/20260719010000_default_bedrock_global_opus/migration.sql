-- Switch the default Bedrock model to the GLOBAL cross-region inference profile
-- (global.anthropic.claude-opus-4-8) — better availability than the region-
-- scoped us.* profile. Applies to Bedrock providers still on the us.* default
-- (from the previous migration) and to any left without a model.
UPDATE "model_providers"
SET "default_model_id" = 'global.anthropic.claude-opus-4-8',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "type" = 'bedrock'
  AND ("default_model_id" IS NULL
       OR "default_model_id" = ''
       OR "default_model_id" = 'us.anthropic.claude-opus-4-8');
