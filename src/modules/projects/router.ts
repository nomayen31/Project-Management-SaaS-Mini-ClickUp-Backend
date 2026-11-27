import { Router, type Request } from "express";
import type { PrismaClient } from "../../generated/prisma/client.js";
import * as schemas from "./schema.js";
import { attachmentRouter } from "./attachments.js";
import type { AttachmentStorage } from "./storage.js";
import { createProjectService } from "./service.js";

export function projectRouter(db: PrismaClient, actor: (request: Request) => { id: string }, storage?: AttachmentStorage) {
  const router = Router({ mergeParams: true });
  const service = createProjectService(db);
  const scope = (request: Request) => ({ workspaceId: schemas.id.parse(request.params.workspaceId), userId: actor(request).id });
  const project = (request: Request) => ({ ...scope(request), projectId: schemas.id.parse(request.params.projectId) });
  const task = (request: Request) => ({ ...project(request), taskId: schemas.id.parse(request.params.taskId) });

  router.use("/:projectId/tasks/:taskId/attachments", attachmentRouter(db, task, storage));

  router.get("/", async (req, res) => {
    res.json({ data: await service.listProjects(scope(req), schemas.projectQuery.parse(req.query)) });
  });
  router.post("/", async (req, res) => {
    res.status(201).json({ data: await service.createProject(scope(req), schemas.projectCreate.parse(req.body)) });
  });
  router.get("/:projectId", async (req, res) => {
    res.json({ data: await service.getProject(project(req)) });
  });
  router.patch("/:projectId", async (req, res) => {
    res.json({ data: await service.updateProject(project(req), schemas.projectUpdate.parse(req.body)) });
  });
  router.delete("/:projectId", async (req, res) => {
    await service.deleteProject(project(req));
    res.sendStatus(204);
  });
  router.get("/:projectId/members", async (req, res) => {
    res.json({ data: await service.listMembers(project(req)) });
  });
  router.post("/:projectId/members", async (req, res) => {
    await service.addMember(project(req), schemas.addMember.parse(req.body).userId);
    res.sendStatus(204);
  });
  router.delete("/:projectId/members/:memberId", async (req, res) => {
    await service.removeMember(project(req), schemas.userId.parse(req.params.memberId));
    res.sendStatus(204);
  });
  router.get("/:projectId/tasks", async (req, res) => {
    res.json({ data: await service.listTasks(project(req), schemas.taskQuery.parse(req.query)) });
  });
  router.post("/:projectId/tasks", async (req, res) => {
    res.status(201).json({ data: await service.createTask(project(req), schemas.taskCreate.parse(req.body)) });
  });
  router.get("/:projectId/tasks/:taskId", async (req, res) => {
    res.json({ data: await service.getTask(task(req)) });
  });
  router.patch("/:projectId/tasks/:taskId", async (req, res) => {
    res.json({ data: await service.updateTask(task(req), schemas.taskUpdate.parse(req.body)) });
  });
  router.delete("/:projectId/tasks/:taskId", async (req, res) => {
    await service.deleteTask(task(req));
    res.sendStatus(204);
  });
  router.put("/:projectId/tasks/:taskId/participants/:memberId", async (req, res) => {
    await service.setParticipant(task(req), schemas.userId.parse(req.params.memberId), schemas.participant.parse(req.body).role);
    res.sendStatus(204);
  });
  router.delete("/:projectId/tasks/:taskId/participants/:memberId", async (req, res) => {
    await service.setParticipant(task(req), schemas.userId.parse(req.params.memberId));
    res.sendStatus(204);
  });
  router.post("/:projectId/tasks/:taskId/subtasks", async (req, res) => {
    res.status(201).json({ data: await service.createSubtask(task(req), schemas.subtaskCreate.parse(req.body).title) });
  });
  router.patch("/:projectId/tasks/:taskId/subtasks/:subtaskId", async (req, res) => {
    await service.changeSubtask(task(req), schemas.id.parse(req.params.subtaskId), schemas.subtaskUpdate.parse(req.body));
    res.sendStatus(204);
  });
  router.delete("/:projectId/tasks/:taskId/subtasks/:subtaskId", async (req, res) => {
    await service.changeSubtask(task(req), schemas.id.parse(req.params.subtaskId));
    res.sendStatus(204);
  });

  return router;
}
