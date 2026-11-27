import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { ApiError } from "../../lib/api-error.js";

type Workload = { userId: string; name: string; open: number; overdue: number };

export function getWorkspaceDashboard(db: PrismaClient, workspaceId: string, userId: string, date: string) {
  const today = new Date(date + "T00:00:00Z");
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() + 14);

  return db.$transaction(async (tx) => {
    const member = await tx.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } }, select: { userId: true },
    });
    if (!member) throw new ApiError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");

    const taskScope: Prisma.TaskWhereInput = { project: { workspaceId } };
    const openTasks: Prisma.TaskWhereInput = { ...taskScope, status: { not: "DONE" } };
    const dueSoon = { gte: today, lt: end };
    const taskStatuses = await tx.task.groupBy({ by: ["status"], where: taskScope, _count: { _all: true } });
    const projectStatuses = await tx.project.groupBy({ by: ["status"], where: { workspaceId }, _count: { _all: true } });
    const overdue = await tx.task.count({ where: { ...openTasks, dueDate: { lt: today } } });
    const unassigned = await tx.task.count({ where: { ...openTasks, participants: { none: { role: "ASSIGNEE" } } } });
    const upcomingTasks = await tx.task.findMany({
      where: { ...openTasks, dueDate: dueSoon },
      select: { id: true, title: true, dueDate: true, project: { select: { id: true, name: true } } },
      orderBy: [{ dueDate: "asc" }, { id: "asc" }], take: 8,
    });
    const upcomingProjects = await tx.project.findMany({
      where: { workspaceId, status: { not: "COMPLETE" }, dueDate: dueSoon },
      select: { id: true, name: true, dueDate: true }, orderBy: [{ dueDate: "asc" }, { id: "asc" }], take: 8,
    });
    const workload = await tx.$queryRaw<Workload[]>`
      SELECT u.id AS "userId", u.name,
             count(t.id)::int AS open,
             count(t.id) FILTER (WHERE t."dueDate" < ${today}::date)::int AS overdue
      FROM workspace_membership AS m
      JOIN "user" AS u ON u.id = m."userId"
      LEFT JOIN project_member AS p ON p."workspaceId" = m."workspaceId" AND p."userId" = m."userId"
      LEFT JOIN task_participant AS a ON a."projectId" = p."projectId" AND a."userId" = p."userId" AND a.role = 'ASSIGNEE'
      LEFT JOIN task AS t ON t.id = a."taskId" AND t."projectId" = p."projectId" AND t.status <> 'DONE'
      WHERE m."workspaceId" = ${workspaceId}::uuid AND m.role <> 'VIEWER'
      GROUP BY u.id, u.name
      ORDER BY open DESC, u.name, u.id
      LIMIT 10
    `;

    return {
      date,
      taskStatuses: taskStatuses.map(({ status, _count }) => ({ status, count: _count._all })),
      projectStatuses: projectStatuses.map(({ status, _count }) => ({ status, count: _count._all })),
      overdue, unassigned, upcomingTasks, upcomingProjects, workload,
    };
  }, { isolationLevel: "RepeatableRead" });
}
