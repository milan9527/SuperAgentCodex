-- Add visibility column to scope_memories for user-level memory isolation.
-- 'scope': visible to all users in the scope (agent knowledge, business rules)
-- 'user': visible only to the creator (personal preferences, interaction patterns)
-- 'session': visible only within the originating session (temporary context)

ALTER TABLE "scope_memories"
  ADD COLUMN "visibility" VARCHAR(20) NOT NULL DEFAULT 'scope';

-- Index for efficient filtering by visibility + user
CREATE INDEX idx_scope_memories_visibility
  ON scope_memories(business_scope_id, visibility);

CREATE INDEX idx_scope_memories_user_visibility
  ON scope_memories(business_scope_id, created_by, visibility);
