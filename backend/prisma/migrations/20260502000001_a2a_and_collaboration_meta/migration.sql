-- A2A support: agents table additions
ALTER TABLE "agents" ADD COLUMN "a2a_enabled" BOOLEAN DEFAULT false;
ALTER TABLE "agents" ADD COLUMN "a2a_capabilities" TEXT;
ALTER TABLE "agents" ADD COLUMN "a2a_exposed_skills" TEXT[];
ALTER TABLE "agents" ADD COLUMN "registry_record_id" VARCHAR(100);
ALTER TABLE "agents" ADD COLUMN "registry_record_arn" TEXT;

-- Index for finding A2A-enabled agents
CREATE INDEX "agents_a2a_enabled_idx" ON "agents"("a2a_enabled") WHERE "a2a_enabled" = true;

-- Collaboration metadata: chat_messages table addition
ALTER TABLE "chat_messages" ADD COLUMN "collaboration_meta" JSONB;

-- Index for querying collaboration messages within a session
CREATE INDEX "chat_messages_collaboration_meta_idx" ON "chat_messages"("session_id")
  WHERE "collaboration_meta" IS NOT NULL;

-- Swarm mode flag on chat_sessions
ALTER TABLE "chat_sessions" ADD COLUMN "swarm_mode" BOOLEAN DEFAULT false;
