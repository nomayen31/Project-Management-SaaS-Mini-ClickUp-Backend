import { randomUUID } from "node:crypto";
import { raw, Router, type Request } from "express";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { ApiError } from "../../lib/api-error.js";
import { id } from "./schema.js";
import { createProjectService, type TaskScope } from "./service.js";
import type { AttachmentStorage } from "./storage.js";

const maxBytes = 3 * 1024 * 1024;
const metadata = { id: true, name: true, bytes: true, mediaType: true, createdAt: true } as const;
const fileName = z.string().trim().min(1).max(150)
  .refine((name) => !/[\\/\x00-\x1f\x7f]/.test(name) && !name.startsWith("."));
const fileTypes = {
  "application/pdf": { extension: ".pdf", signature: Buffer.from("%PDF-") },
  "image/png": { extension: ".png", signature: Buffer.from("89504e470d0a1a0a", "hex") },
  "image/jpeg": { extension: ".jpg", signature: Buffer.from("ffd8ff", "hex") },
};

function parseUpload(request: Request) {
  const mediaType = request.get("content-type")?.split(";")[0].toLowerCase() ?? "";
  const format = Object.hasOwn(fileTypes, mediaType) ? fileTypes[mediaType as keyof typeof fileTypes] : undefined;
  const contents: unknown = request.body;
  if (!format || !Buffer.isBuffer(contents) || contents.length <= format.signature.length ||
      !contents.subarray(0, format.signature.length).equals(format.signature)) {
    throw new ApiError(415, "INVALID_ATTACHMENT_TYPE", "Choose a PDF, PNG, or JPEG file.");
  }

  let name: string;
  try { name = fileName.parse(decodeURIComponent(request.get("x-taskflow-file-name") ?? "")); }
  catch { throw new ApiError(400, "INVALID_ATTACHMENT_NAME", "Choose a file with a valid name."); }
  return { name, contents, mediaType, extension: format.extension };
}

export function attachmentRouter(db: PrismaClient, task: (request: Request) => TaskScope, storage?: AttachmentStorage) {
  const router = Router({ mergeParams: true });
  const service = createProjectService(db);

  router.get("/", async (req, res) => {
    const scope = task(req);
    const items = await service.withTask(scope, "read", (tx) => tx.attachment.findMany({
      where: { taskId: scope.taskId, ready: true }, select: metadata, orderBy: { createdAt: "asc" },
    }));
    res.json({ data: { items, uploadsEnabled: Boolean(storage) } });
  });

  router.post("/", raw({ type: () => true, limit: maxBytes, inflate: false }), async (req, res) => {
    const scope = task(req);
    const file = parseUpload(req);
    if (!storage) throw new ApiError(503, "ATTACHMENTS_UNAVAILABLE", "File storage is unavailable.");
    const storageId = `taskflow/${randomUUID()}${file.extension}`;
    const reservation = await service.withTask(scope, "task", async (tx) => {
      const count = await tx.attachment.count({ where: { taskId: scope.taskId } });
      if (count >= 20) throw new ApiError(409, "ATTACHMENT_LIMIT", "A task can hold up to 20 attachments.");
      return tx.attachment.create({
        data: { taskId: scope.taskId, storageId, name: file.name, bytes: file.contents.length, mediaType: file.mediaType },
        select: { id: true },
      });
    });

    try {
      await storage.upload(storageId, file.contents);
      const attachment = await service.withTask(scope, "task", (tx) => tx.attachment.update({
        where: { id: reservation.id, taskId: scope.taskId, ready: false }, data: { ready: true }, select: metadata,
      }));
      res.status(201).json({ data: attachment });
    } catch (error) {
      await db.attachment.deleteMany({ where: { id: reservation.id, ready: false } }).catch(() => undefined);
      throw error;
    }
  });

  router.get("/:attachmentId/download", async (req, res) => {
    const scope = task(req);
    const attachmentId = id.parse(req.params.attachmentId);
    const attachment = await service.withTask(scope, "read", (tx) => tx.attachment.findFirst({
      where: { id: attachmentId, taskId: scope.taskId, ready: true }, select: { storageId: true },
    }));
    if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", "Attachment not found.");
    if (!storage) throw new ApiError(503, "ATTACHMENTS_UNAVAILABLE", "File storage is unavailable.");
    res.set("Referrer-Policy", "no-referrer");
    res.redirect(302, storage.download(attachment.storageId));
  });

  router.delete("/:attachmentId", async (req, res) => {
    const scope = task(req);
    const attachmentId = id.parse(req.params.attachmentId);
    const deleted = await service.withTask(scope, "task", (tx) => tx.attachment.deleteMany({
      where: { id: attachmentId, taskId: scope.taskId, ready: true },
    }));
    if (!deleted.count) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", "Attachment not found.");
    res.sendStatus(204);
  });

  return router;
}
