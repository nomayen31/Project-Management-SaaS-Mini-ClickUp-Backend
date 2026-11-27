-- Persist an order for each project status column.
ALTER TABLE "task" ADD COLUMN "boardPosition" INTEGER NOT NULL DEFAULT 0;

WITH ordered AS (
    SELECT "id", row_number() OVER (PARTITION BY "projectId", "status" ORDER BY "createdAt" DESC, "id")::integer - 1 AS position
    FROM "task"
)
UPDATE "task" AS task SET "boardPosition" = ordered.position
FROM ordered WHERE task."id" = ordered."id";

CREATE INDEX "task_projectId_status_boardPosition_idx" ON "task"("projectId", "status", "boardPosition");
