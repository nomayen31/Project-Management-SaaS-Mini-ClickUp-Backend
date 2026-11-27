import { v2 as cloudinary } from "cloudinary";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { ApiError } from "../../lib/api-error.js";

export type AttachmentStorage = {
  upload(id: string, contents: Buffer): Promise<void>;
  download(id: string): string;
  remove(id: string): Promise<void>;
};

export function loadAttachmentStorage(): AttachmentStorage | undefined {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_CLOUD_NAME && !CLOUDINARY_API_KEY && !CLOUDINARY_API_SECRET) return undefined;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new Error("Incomplete Cloudinary configuration.");
  }
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME, api_key: CLOUDINARY_API_KEY, api_secret: CLOUDINARY_API_SECRET, secure: true,
  });

  return {
    upload(id, contents) {
      return new Promise<void>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({
          public_id: id, resource_type: "raw", type: "authenticated", overwrite: false, timeout: 30_000,
        }, (error, result) => {
          if (error || result?.public_id !== id) {
            reject(new ApiError(502, "ATTACHMENT_UPLOAD_FAILED", "File storage could not complete the upload."));
          } else resolve();
        });
        stream.on("error", () => reject(new ApiError(502, "ATTACHMENT_UPLOAD_FAILED", "File storage could not complete the upload.")));
        stream.end(contents);
      });
    },
    download(id) {
      return cloudinary.utils.private_download_url(id, "", {
        resource_type: "raw", type: "authenticated",
        expires_at: Math.floor(Date.now() / 1000) + 60, attachment: true,
      });
    },
    async remove(id) {
      const options = { resource_type: "raw", type: "authenticated", invalidate: true, timeout: 15_000 } as const;
      const result = await cloudinary.uploader.destroy(id, options);
      if (result.result !== "ok" && result.result !== "not found") throw new Error("Attachment cleanup failed.");
    },
  };
}

export function startAttachmentCleanup(db: PrismaClient, storage: AttachmentStorage) {
  let busy = false;
  async function cleanup() {
    if (busy) return;
    busy = true;
    try {
      await db.attachment.deleteMany({
        where: { ready: false, createdAt: { lt: new Date(Date.now() - 10 * 60_000) } },
      });
      const jobs = await db.attachmentCleanup.findMany({
        where: { retryAt: { lte: new Date() } }, orderBy: { retryAt: "asc" }, take: 10,
      });
      for (const { storageId } of jobs) {
        try {
          await storage.remove(storageId);
          await db.attachmentCleanup.deleteMany({ where: { storageId } });
        } catch {
          await db.attachmentCleanup.updateMany({ where: { storageId }, data: { retryAt: new Date(Date.now() + 5 * 60_000) } });
        }
      }
    } catch {
      console.error("TaskFlow attachment cleanup could not run.");
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => { void cleanup(); }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
