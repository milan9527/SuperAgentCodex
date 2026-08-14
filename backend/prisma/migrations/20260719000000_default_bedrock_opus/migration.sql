-- The org-default "Amazon Bedrock" provider was seeded (in the add_model_providers
-- migration) with no default_model_id, so it shows no model in Settings → Models
-- and the chat picker. Backfill a sensible default (Claude Opus 4.8 inference
-- profile) for any Bedrock provider that still has no model configured.
UPDATE "model_providers"
SET "default_model_id" = 'us.anthropic.claude-opus-4-8',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "type" = 'bedrock'
  AND ("default_model_id" IS NULL OR "default_model_id" = '');
