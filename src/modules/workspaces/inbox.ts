import { Router, type Request } from "express";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { ApiError } from "../../lib/api-error.js";
import { pageInput, pageSize } from "../projects/discussion.js";

const id = z.uuid();
const workspace = (req: Request) => id.parse(req.params.workspaceId);
const taskDetails = { id: true, title: true, projectId: true } as const;

export function workspaceInboxRouter(db: PrismaClient, actor: (req: Request) => { id: string }) {
  const router = Router({ mergeParams: true });

  async function requireMembership(tx: Prisma.TransactionClient, workspaceId: string, userId: string) {
    const member = await tx.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } }, select: { userId: true },
    });
    if (!member) throw new ApiError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
  }

  router.get("/notifications", async (req, res) => {
    const workspaceId = workspace(req);
    const userId = actor(req).id;
    const { page } = pageInput.parse(req.query);
    const data = await db.$transaction(async (tx) => {
      await requireMembership(tx, workspaceId, userId);
      const where = { workspaceId, userId, task: { project: { workspaceId } } };
      const rows = await tx.workspaceNotification.findMany({
        where,
        select: { id: true, readAt: true, createdAt: true, task: { select: taskDetails }, actor: { select: { name: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize + 1,
      });
      return { items: rows.slice(0, pageSize), hasMore: rows.length > pageSize, unread: await tx.workspaceNotification.count({ where: { ...where, readAt: null } }) };
    }, { isolationLevel: "RepeatableRead" });
    res.json({ data });
  });

  router.patch("/notifications/:notificationId/read", async (req, res) => {
    const workspaceId = workspace(req);
    const userId = actor(req).id;
    const notificationId = id.parse(req.params.notificationId);
    const where = { id: notificationId, workspaceId, userId, task: { project: { workspaceId } } };
    await db.$transaction(async (tx) => {
      const notification = await tx.workspaceNotification.findFirst({ where, select: { id: true } });
      if (!notification) throw new ApiError(404, "NOTIFICATION_NOT_FOUND", "Notification not found.");
      await tx.workspaceNotification.updateMany({ where: { ...where, readAt: null }, data: { readAt: new Date() } });
    });
    res.sendStatus(204);
  });

  router.get("/activity-feed", async (req, res) => {
    const workspaceId = workspace(req);
    const userId = actor(req).id;
    const { page } = pageInput.parse(req.query);
    const rows = await db.$transaction(async (tx) => {
      await requireMembership(tx, workspaceId, userId);
      return tx.taskActivity.findMany({
        where: { task: { project: { workspaceId } } },
        select: { id: true, type: true, detail: true, createdAt: true, task: { select: taskDetails }, actor: { select: { name: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize + 1,
      });
    }, { isolationLevel: "RepeatableRead" });
    res.json({ data: { items: rows.slice(0, pageSize), hasMore: rows.length > pageSize } });
  });
  return router;
}
