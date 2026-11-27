-- CreateEnum
CREATE TYPE "TaskActivityType" AS ENUM ('CREATED', 'UPDATED', 'MOVED', 'COMMENTED');

-- CreateTable
CREATE TABLE "task_comment" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_activity" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "actorId" TEXT NOT NULL,
    "type" "TaskActivityType" NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_notification" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "taskId" UUID NOT NULL,
    "actorId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_comment_taskId_createdAt_id_idx" ON "task_comment"("taskId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "task_comment_authorId_idx" ON "task_comment"("authorId");

-- CreateIndex
CREATE INDEX "task_activity_taskId_createdAt_id_idx" ON "task_activity"("taskId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "task_activity_actorId_idx" ON "task_activity"("actorId");

-- CreateIndex
CREATE INDEX "workspace_notification_workspaceId_userId_readAt_createdAt_idx" ON "workspace_notification"("workspaceId", "userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "workspace_notification_taskId_idx" ON "workspace_notification"("taskId");

-- CreateIndex
CREATE INDEX "workspace_notification_actorId_idx" ON "workspace_notification"("actorId");

-- AddForeignKey
ALTER TABLE "task_comment" ADD CONSTRAINT "task_comment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comment" ADD CONSTRAINT "task_comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_notification" ADD CONSTRAINT "workspace_notification_workspaceId_userId_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "workspace_membership"("workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_notification" ADD CONSTRAINT "workspace_notification_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_notification" ADD CONSTRAINT "workspace_notification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
