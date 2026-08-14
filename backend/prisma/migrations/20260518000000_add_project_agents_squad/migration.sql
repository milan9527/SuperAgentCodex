-- CreateTable: project_agents (multi-agent squad for projects)
CREATE TABLE "project_agents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "role" VARCHAR(30) NOT NULL DEFAULT 'worker',
    "is_leader" BOOLEAN NOT NULL DEFAULT false,
    "auto_assign_labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "instructions" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_agents_pkey" PRIMARY KEY ("id")
);

-- Add assigned_agent_id to project_issues
ALTER TABLE "project_issues" ADD COLUMN "assigned_agent_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "unique_project_agent" ON "project_agents"("project_id", "agent_id");
CREATE INDEX "project_agents_project_id_idx" ON "project_agents"("project_id");
CREATE INDEX "project_agents_agent_id_idx" ON "project_agents"("agent_id");
CREATE INDEX "project_agents_project_id_is_leader_idx" ON "project_agents"("project_id", "is_leader");
CREATE INDEX "project_issues_assigned_agent_id_idx" ON "project_issues"("assigned_agent_id");

-- AddForeignKey
ALTER TABLE "project_agents" ADD CONSTRAINT "project_agents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_agents" ADD CONSTRAINT "project_agents_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
