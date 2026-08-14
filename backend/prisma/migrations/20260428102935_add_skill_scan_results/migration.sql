-- DropIndex
DROP INDEX "chat_room_members_source_scope_id_idx";

-- CreateTable
CREATE TABLE "skill_scan_results" (
    "id" UUID NOT NULL,
    "skill_id" UUID NOT NULL,
    "scan_type" VARCHAR(32) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "findings" JSONB NOT NULL DEFAULT '[]',
    "summary" TEXT,
    "scanned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_scan_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "skill_scan_results_skill_id_idx" ON "skill_scan_results"("skill_id");

-- CreateIndex
CREATE INDEX "skill_scan_results_scan_type_idx" ON "skill_scan_results"("scan_type");

-- CreateIndex
CREATE INDEX "skill_scan_results_scanned_at_idx" ON "skill_scan_results"("scanned_at" DESC);

-- CreateIndex
CREATE INDEX "skill_scan_results_skill_id_scan_type_idx" ON "skill_scan_results"("skill_id", "scan_type");

-- AddForeignKey
ALTER TABLE "skill_scan_results" ADD CONSTRAINT "skill_scan_results_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
