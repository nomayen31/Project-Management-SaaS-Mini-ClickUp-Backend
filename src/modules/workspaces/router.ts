import { fromNodeHeaders } from "better-auth/node";
import { json, Router } from "express";
import { z } from "zod";
import type { loadAuth } from "../../auth.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { ApiError } from "../../lib/api-error.js";
import { createWorkspaceService } from "./service.js";

type Auth = NonNullable<ReturnType<typeof loadAuth>>["instance"];
const id = z.uuid();
const userId = z.string().min(1).max(128);
const name = z.object({ name: z.string().trim().min(2).max(80) }).strict();
const role = z.enum(["ADMIN", "MEMBER", "VIEWER"]);
const roleBody = z.object({ role }).strict();
const invitation = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  role,
}).strict();
const acceptance = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

export function workspaceRouter(auth: Auth, db: PrismaClient, appOrigin: string) {
  const router = Router();
  const service = createWorkspaceService(db);
  const actors = new WeakMap<object, { id: string; email: string; emailVerified: boolean }>();
  function actor(request: object) {
    const user = actors.get(request);
    if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
    return user;
  }

  router.use(async (request, response, next) => {
    response.set("Cache-Control", "no-store");
    if (request.method !== "GET" && request.method !== "HEAD" && request.get("origin") !== appOrigin) {
      throw new ApiError(403, "INVALID_ORIGIN", "This request origin is not allowed.");
    }
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
    if (!session.user.emailVerified) throw new ApiError(403, "EMAIL_UNVERIFIED", "Verify your email to continue.");
    actors.set(request, session.user);
    next();
  });
  router.use(json({ limit: "16kb" }));

  router.get("/", async (request, response) => {
    response.json({ data: await service.list(actor(request).id) });
  });
  router.post("/", async (request, response) => {
    response.status(201).json({ data: await service.create(actor(request).id, name.parse(request.body).name) });
  });
  router.post("/invitations/accept", async (request, response) => {
    response.json({ data: await service.accept(acceptance.parse(request.body).token, actor(request)) });
  });
  router.get("/:workspaceId", async (request, response) => {
    response.json({ data: await service.detail(id.parse(request.params.workspaceId), actor(request).id) });
  });
  router.patch("/:workspaceId", async (request, response) => {
    response.json({ data: await service.rename(id.parse(request.params.workspaceId), actor(request).id, name.parse(request.body).name) });
  });
  router.get("/:workspaceId/members", async (request, response) => {
    response.json({ data: await service.members(id.parse(request.params.workspaceId), actor(request).id) });
  });
  router.patch("/:workspaceId/members/:userId", async (request, response) => {
    const data = await service.manageMember(id.parse(request.params.workspaceId), actor(request).id, userId.parse(request.params.userId), roleBody.parse(request.body).role);
    response.json({ data });
  });
  router.delete("/:workspaceId/members/:userId", async (request, response) => {
    await service.manageMember(id.parse(request.params.workspaceId), actor(request).id, userId.parse(request.params.userId));
    response.sendStatus(204);
  });
  router.get("/:workspaceId/invitations", async (request, response) => {
    response.json({ data: await service.invitations(id.parse(request.params.workspaceId), actor(request).id) });
  });
  router.post("/:workspaceId/invitations", async (request, response) => {
    const { email, role: requestedRole } = invitation.parse(request.body);
    response.status(201).json({ data: await service.invite(id.parse(request.params.workspaceId), actor(request).id, email, requestedRole) });
  });
  router.delete("/:workspaceId/invitations/:invitationId", async (request, response) => {
    await service.revokeInvitation(id.parse(request.params.workspaceId), actor(request).id, id.parse(request.params.invitationId));
    response.sendStatus(204);
  });

  return router;
}
