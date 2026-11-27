-- CreateTable
CREATE TABLE "attachment" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "storageId" TEXT NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "bytes" INTEGER NOT NULL,
    "mediaType" VARCHAR(32) NOT NULL,
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachment_cleanup" (
    "storageId" TEXT NOT NULL,
    "retryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_cleanup_pkey" PRIMARY KEY ("storageId")
);

-- CreateIndex
CREATE UNIQUE INDEX "attachment_storageId_key" ON "attachment"("storageId");

-- CreateIndex
CREATE INDEX "attachment_taskId_createdAt_idx" ON "attachment"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "attachment_ready_createdAt_idx" ON "attachment"("ready", "createdAt");

-- CreateIndex
CREATE INDEX "attachment_cleanup_retryAt_idx" ON "attachment_cleanup"("retryAt");

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Queue deletion of the provider asset even when the task or project is removed.
CREATE FUNCTION enqueue_attachment_cleanup() RETURNS trigger AS $$
BEGIN
    INSERT INTO "attachment_cleanup" ("storageId", "retryAt")
    VALUES (OLD."storageId", CASE WHEN OLD."ready" THEN CURRENT_TIMESTAMP
        ELSE GREATEST(CURRENT_TIMESTAMP, OLD."createdAt" + INTERVAL '10 minutes') END)
    ON CONFLICT ("storageId") DO NOTHING;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER attachment_cleanup_after_delete
AFTER DELETE ON "attachment"
FOR EACH ROW EXECUTE FUNCTION enqueue_attachment_cleanup();
