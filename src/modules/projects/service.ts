import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import type { TaskParticipantRole } from "../../generated/prisma/enums.js";
import { ApiError } from "../../lib/api-error.js";
import type { z } from "zod";
import type { projectQuery, projectUpdate, projectCreate, taskQuery, taskUpdate, taskCreate, subtaskUpdate } from "./schema.js";

type Tx = Prisma.TransactionClient;
type Scope = { workspaceId: string; userId: string };
type ProjectScope = Scope & { projectId: string };
export type TaskScope = ProjectScope & { taskId: string };
const person = { id: true, name: true, image: true } as const;
const projectFields = {
  id: true, name: true, description: true, status: true, priority: true, dueDate: true,
  createdAt: true, updatedAt: true, _count: { select: { tasks: true } },
} as const;
const taskFields = {
  id: true, title: true, description: true, status: true, priority: true, startDate: true, dueDate: true,
  labels: true, createdAt: true, updatedAt: true,
  participants: { orderBy: { userId: "asc" }, select: { role: true, member: { select: { membership: { select: { user: { select: person } } } } } } },
  subtasks: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, title: true, completed: true } },
} as const satisfies Prisma.TaskSelect;

async function membership(tx: Tx, { workspaceId, userId }: Scope) {
  const member = await tx.workspaceMembership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
  if (!member) throw new ApiError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
  return member;
}

function manager(role: string) {
  if (role !== "OWNER" && role !== "ADMIN") throw new ApiError(403, "FORBIDDEN", "You cannot manage projects in this workspace.");
}

async function projectAccess(tx: Tx, scope: ProjectScope, access: "read" | "manage" | "task" = "read") {
  const { role } = await membership(tx, scope);
  const project = await tx.project.findUnique({
    where: { id_workspaceId: { id: scope.projectId, workspaceId: scope.workspaceId } }, select: projectFields,
  });
  if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found.");
  if (access === "manage") manager(role);
  if (access === "task" && role !== "OWNER" && role !== "ADMIN") {
    const canEdit = role === "MEMBER" && await tx.projectMember.findUnique({
      where: { projectId_userId: { projectId: scope.projectId, userId: scope.userId } },
    });
    if (!canEdit) throw new ApiError(403, "FORBIDDEN", "You cannot edit tasks in this project.");
  }
  return project;
}

async function existingTask(tx: Tx, scope: TaskScope, access: "read" | "task") {
  await projectAccess(tx, scope, access);
  const task = await tx.task.findUnique({ where: { id_projectId: { id: scope.taskId, projectId: scope.projectId } }, select: taskFields });
  if (!task) throw new ApiError(404, "TASK_NOT_FOUND", "Task not found.");
  return task;
}

function checkDates(startDate?: Date | null, dueDate?: Date | null) {
  if (startDate && dueDate && startDate > dueDate) throw new ApiError(400, "INVALID_DATE_RANGE", "The due date must be on or after the start date.");
}

type TaskRow = Prisma.TaskGetPayload<{ select: typeof taskFields }>;

function taskResponse(row: TaskRow) {
  const { participants, ...task } = row;
  return { ...task, participants: participants.map(({ role, member }) => ({ role, user: member.membership.user })) };
}

function pagination(page: number, limit: number, total: number) {
  return { page, limit, total, pages: Math.ceil(total / limit) };
}

export function createProjectService(db: PrismaClient) {
  function read<T>(operation: (tx: Tx) => Promise<T>) {
    return db.$transaction(operation, { isolationLevel: "RepeatableRead" });
  }
  function write<T>(scope: Scope, operation: (tx: Tx) => Promise<T>) {
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "workspace" WHERE "id" = ${scope.workspaceId}::uuid FOR UPDATE`;
      return operation(tx);
    });
  }

  async function progress(tx: Tx, projects: Array<Prisma.ProjectGetPayload<{ select: typeof projectFields }>>) {
    if (projects.length === 0) return [];
    const done = await tx.task.groupBy({
      by: ["projectId"], where: { projectId: { in: projects.map(({ id }) => id) }, status: "DONE" }, _count: { _all: true },
    });
    const counts = new Map(done.map(({ projectId, _count }) => [projectId, _count._all]));
    return projects.map(({ _count, ...project }) => ({ ...project, totalTasks: _count.tasks, completedTasks: counts.get(project.id) ?? 0 }));
  }

  return {
    withTask<T>(scope: TaskScope, access: "read" | "task", operation: (tx: Tx) => Promise<T>) {
      const authorize = async (tx: Tx) => {
        await existingTask(tx, scope, access);
        return operation(tx);
      };
      return access === "read" ? read(authorize) : write(scope, authorize);
    },
    listProjects(scope: Scope, input: z.infer<typeof projectQuery>) {
      return read(async (tx) => {
        await membership(tx, scope);
        const where: Prisma.ProjectWhereInput = {
          workspaceId: scope.workspaceId, status: input.status, priority: input.priority,
          name: input.search ? { contains: input.search, mode: "insensitive" } : undefined,
        };
        const orderBy: Prisma.ProjectOrderByWithRelationInput = input.sort === "name" ? { name: "asc" } :
          input.sort === "due" ? { dueDate: { sort: "asc", nulls: "last" } } : { createdAt: "desc" };
        const projects = await tx.project.findMany({
          where, select: projectFields, orderBy: [orderBy, { id: "asc" }], skip: (input.page - 1) * input.limit, take: input.limit,
        });
        return { items: await progress(tx, projects), ...pagination(input.page, input.limit, await tx.project.count({ where })) };
      });
    },
    createProject(scope: Scope, data: z.infer<typeof projectCreate>) {
      return write(scope, async (tx) => {
        manager((await membership(tx, scope)).role);
        const project = await tx.project.create({
          data: { workspaceId: scope.workspaceId, ...data }, select: projectFields,
        });
        await tx.projectMember.create({ data: { projectId: project.id, workspaceId: scope.workspaceId, userId: scope.userId } });
        return (await progress(tx, [project]))[0];
      });
    },
    getProject(scope: ProjectScope) {
      return read(async (tx) => (await progress(tx, [await projectAccess(tx, scope)]))[0]);
    },
    updateProject(scope: ProjectScope, data: z.infer<typeof projectUpdate>) {
      return write(scope, async (tx) => {
        await projectAccess(tx, scope, "manage");
        const project = await tx.project.update({ where: { id: scope.projectId }, data, select: projectFields });
        return (await progress(tx, [project]))[0];
      });
    },
    deleteProject(scope: ProjectScope) {
      return write(scope, async (tx) => {
        await projectAccess(tx, scope, "manage");
        await tx.project.delete({ where: { id: scope.projectId } });
      });
    },
    listMembers(scope: ProjectScope) {
      return read(async (tx) => {
        await projectAccess(tx, scope);
        const members = await tx.projectMember.findMany({
          where: { projectId: scope.projectId }, orderBy: { userId: "asc" },
          select: { membership: { select: { role: true, user: { select: person } } } },
        });
        return members.map(({ membership }) => membership);
      });
    },
    addMember(scope: ProjectScope, userId: string) {
      return write(scope, async (tx) => {
        await projectAccess(tx, scope, "manage");
        const member = await membership(tx, { workspaceId: scope.workspaceId, userId });
        if (member.role === "VIEWER") throw new ApiError(400, "INVALID_PROJECT_MEMBER", "Viewers cannot join a project team.");
        const { projectId, workspaceId } = scope;
        await tx.projectMember.upsert({
          where: { projectId_userId: { projectId, userId } }, create: { projectId, workspaceId, userId }, update: {},
        });
      });
    },
    removeMember(scope: ProjectScope, userId: string) {
      return write(scope, async (tx) => {
        await projectAccess(tx, scope, "manage");
        await tx.projectMember.deleteMany({ where: { projectId: scope.projectId, userId } });
      });
    },
    listTasks(scope: ProjectScope, input: z.infer<typeof taskQuery>) {
      return read(async (tx) => {
        await projectAccess(tx, scope);
        const where: Prisma.TaskWhereInput = {
          projectId: scope.projectId, status: input.status, priority: input.priority,
          title: input.search ? { contains: input.search, mode: "insensitive" } : undefined,
          labels: input.label ? { has: input.label } : undefined,
        };
        const orderBy: Prisma.TaskOrderByWithRelationInput = input.sort === "name" ? { title: "asc" } :
          input.sort === "due" ? { dueDate: { sort: "asc", nulls: "last" } } : { createdAt: "desc" };
        const items = await tx.task.findMany({
          where, orderBy: [orderBy, { id: "asc" }], skip: (input.page - 1) * input.limit, take: input.limit, select: taskFields,
        });
        return { items: items.map(taskResponse), ...pagination(input.page, input.limit, await tx.task.count({ where })) };
      });
    },
    createTask(scope: ProjectScope, data: z.infer<typeof taskCreate>) {
      return write(scope, async (tx) => {
        await projectAccess(tx, scope, "task");
        checkDates(data.startDate, data.dueDate);
        return taskResponse(await tx.task.create({ data: { projectId: scope.projectId, ...data }, select: taskFields }));
      });
    },
    getTask(scope: TaskScope) {
      return read(async (tx) => taskResponse(await existingTask(tx, scope, "read")));
    },
    updateTask(scope: TaskScope, data: z.infer<typeof taskUpdate>) {
      return write(scope, async (tx) => {
        const task = await existingTask(tx, scope, "task");
        checkDates(data.startDate === undefined ? task.startDate : data.startDate, data.dueDate === undefined ? task.dueDate : data.dueDate);
        return taskResponse(await tx.task.update({ where: { id: scope.taskId }, data, select: taskFields }));
      });
    },
    deleteTask(scope: TaskScope) {
      return write(scope, async (tx) => {
        await existingTask(tx, scope, "task");
        await tx.task.delete({ where: { id: scope.taskId } });
      });
    },
    setParticipant(scope: TaskScope, userId: string, role?: TaskParticipantRole) {
      return write(scope, async (tx) => {
        await existingTask(tx, scope, "task");
        const { taskId, projectId, workspaceId } = scope;
        if (!role) {
          await tx.taskParticipant.deleteMany({ where: { taskId, userId } });
          return;
        }
        const eligible = await tx.projectMember.findFirst({
          where: { projectId, workspaceId, userId, membership: { role: { not: "VIEWER" } } },
        });
        if (!eligible) throw new ApiError(400, "INVALID_TASK_PARTICIPANT", "Choose a member of this project.");
        await tx.taskParticipant.upsert({
          where: { taskId_userId: { taskId, userId } }, create: { taskId, projectId, userId, role }, update: { role },
        });
      });
    },
    createSubtask(scope: TaskScope, title: string) {
      return write(scope, async (tx) => {
        await existingTask(tx, scope, "task");
        return tx.subtask.create({ data: { taskId: scope.taskId, title }, select: { id: true, title: true, completed: true } });
      });
    },
    changeSubtask(scope: TaskScope, subtaskId: string, data?: z.infer<typeof subtaskUpdate>) {
      return write(scope, async (tx) => {
        await existingTask(tx, scope, "task");
        const where = { id: subtaskId, taskId: scope.taskId };
        const result = data ? await tx.subtask.updateMany({ where, data }) : await tx.subtask.deleteMany({ where });
        if (!result.count) throw new ApiError(404, "SUBTASK_NOT_FOUND", "Subtask not found.");
      });
    },
  };
}
