/*
  Warnings:

  - Made the column `a2a_enabled` on table `agents` required. This step will fail if there are existing NULL values in that column.
  - Made the column `swarm_mode` on table `chat_sessions` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "agents" ALTER COLUMN "a2a_enabled" SET NOT NULL,
ALTER COLUMN "a2a_exposed_skills" SET DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "chat_sessions" ALTER COLUMN "swarm_mode" SET NOT NULL;

-- CreateIndex (drop partial index from previous migration, replace with standard index)
DROP INDEX IF EXISTS "agents_a2a_enabled_idx";
CREATE INDEX "agents_a2a_enabled_idx" ON "agents"("a2a_enabled");
