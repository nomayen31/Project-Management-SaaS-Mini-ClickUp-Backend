import { Router, type Request } from "express";
import { z } from "zod";
import { ApiError } from "../../lib/api-error.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { createProjectService, type TaskScope } from "./service.js";

const commentInput = z.object({
  body: z.string().trim().min(1).max(4000),
  mentions: z.array(z.string().min(1).max(128)).max(10).default([]),
}).strict();
export const pageInput = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1) }).strict();
export const pageSize = 20;
const publicUser = { id: true, name: true } as const;

export function discussionRouter(db: PrismaClient, task: (request: Request) => TaskScope) {
  const router = Router({ mergeParams: true });
  const service = createProjectService(db);

  router.get("/comments", async (req, res) => {
    const scope = task(req);
    const { page } = pageInput.parse(req.query);
    const rows = await service.withTask(scope, "read", (tx) => tx.taskComment.findMany({
      where: { taskId: scope.taskId },
      select: { id: true, body: true, createdAt: true, author: { select: publicUser } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize, take: pageSize + 1,
    }));
    res.json({ data: { items: rows.slice(0, pageSize), hasMore: rows.length > pageSize } });
  });

  router.post("/comments", async (req, res) => {
    const scope = task(req);
    const input = commentInput.parse(req.body);
    const comment = await service.withTask(scope, "task", async (tx) => {
      const mentions = [...new Set(input.mentions)].filter((id) => id !== scope.userId);
      const recipients = await tx.workspaceMembership.findMany({
        where: { workspaceId: scope.workspaceId, userId: { in: mentions } }, select: { userId: true, user: { select: { mentionNotifications: true } } },
      });
      if (recipients.length !== mentions.length) {
        throw new ApiError(400, "INVALID_MENTION", "Mention people in this workspace.");
      }

      const row = await tx.taskComment.create({
        data: { taskId: scope.taskId, authorId: scope.userId, body: input.body },
        select: { id: true, body: true, createdAt: true, author: { select: publicUser } },
      });
      await tx.taskActivity.create({ data: { taskId: scope.taskId, actorId: scope.userId, type: "COMMENTED" } });
      const notified = recipients.filter(({ user }) => user.mentionNotifications);
      if (notified.length) {
        await tx.workspaceNotification.createMany({
          data: notified.map(({ userId }) => ({
            workspaceId: scope.workspaceId, taskId: scope.taskId, actorId: scope.userId, userId,
          })),
        });
      }
      return row;
    });
    res.status(201).json({ data: comment });
  });

  router.get("/activity", async (req, res) => {
    const scope = task(req);
    const { page } = pageInput.parse(req.query);
    const rows = await service.withTask(scope, "read", (tx) => tx.taskActivity.findMany({
      where: { taskId: scope.taskId },
      select: { id: true, type: true, detail: true, createdAt: true, actor: { select: publicUser } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageSize + 1, skip: (page - 1) * pageSize,
    }));
    res.json({ data: { items: rows.slice(0, pageSize), hasMore: rows.length > pageSize } });
  });

  return router;
}
