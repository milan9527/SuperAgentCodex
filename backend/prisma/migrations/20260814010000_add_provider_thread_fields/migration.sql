ALTER TABLE "chat_sessions"
  ADD COLUMN IF NOT EXISTS "provider_runtime" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "provider_thread_id" TEXT,
  ADD COLUMN IF NOT EXISTS "provider_thread_model" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "provider_thread_metadata" JSONB DEFAULT '{}'::jsonb;

UPDATE "chat_sessions"
SET
  "provider_runtime" = 'claude',
  "provider_thread_id" = "claude_session_id",
  "provider_thread_model" = "claude_session_model"
WHERE "claude_session_id" IS NOT NULL
  AND "provider_thread_id" IS NULL;

CREATE INDEX IF NOT EXISTS "chat_sessions_provider_runtime_provider_thread_id_idx"
  ON "chat_sessions" ("provider_runtime", "provider_thread_id");

CREATE UNIQUE INDEX IF NOT EXISTS "chat_sessions_provider_thread_unique"
  ON "chat_sessions" ("provider_runtime", "provider_thread_id")
  WHERE "provider_thread_id" IS NOT NULL;

ALTER TABLE "chat_sessions"
  DROP CONSTRAINT IF EXISTS "chat_sessions_provider_thread_requires_runtime";

ALTER TABLE "chat_sessions"
  ADD CONSTRAINT "chat_sessions_provider_thread_requires_runtime"
  CHECK ("provider_thread_id" IS NULL OR "provider_runtime" IS NOT NULL);
