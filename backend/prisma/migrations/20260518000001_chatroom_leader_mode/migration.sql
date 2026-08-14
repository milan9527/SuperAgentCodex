-- Add leader mode fields to chat_room_members
ALTER TABLE "chat_room_members" ADD COLUMN IF NOT EXISTS "is_leader" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "chat_room_members" ADD COLUMN IF NOT EXISTS "leader_instructions" TEXT;
