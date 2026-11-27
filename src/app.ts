import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import { loadAuth } from "./auth.js";
import express, { type ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { healthRouter } from "./modules/health.js";
import { readinessRouter } from "./modules/readiness.js";
import { workspaceRouter } from "./modules/workspaces/router.js";
import { loadAttachmentStorage, type AttachmentStorage } from "./modules/projects/storage.js";
import { accountRouter } from "./modules/account.js";
import { ApiError } from "./lib/api-error.js";

type AuthConfig = NonNullable<ReturnType<typeof loadAuth>>;
type AppAuth = Pick<AuthConfig, "instance" | "providers"> & { workspace?: AuthConfig["workspace"] };

export function createApp(auth?: AppAuth, storage?: AttachmentStorage, app = express()) {
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.set("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use("/api", healthRouter, readinessRouter);
  app.get("/api/auth-providers", (_request, response) => {
    response.set("Cache-Control", "no-store");
    response.json({ data: auth?.providers ?? { email: false, google: false, dash: false, sentinel: false } });
  });
  if (auth) {
    const authHandler = toNodeHandler(auth.instance);
    app.all("/api/auth/{*splat}", (request, response) => {
      // Overwrite client-supplied values until a trusted ingress is configured.
      request.headers["x-taskflow-client-ip"] = request.socket.remoteAddress;
      return authHandler(request, response);
    });
    if (auth.workspace) {
      app.use("/api/me", accountRouter(auth.instance, auth.workspace));
      app.use("/api/workspaces", workspaceRouter(auth.instance, auth.workspace.database, auth.workspace.origin, storage));
    }
    app.get("/api/me", async (request, response) => {
      response.set("Cache-Control", "no-store");
      const session = await auth.instance.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) {
        response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } });
        return;
      }
      const { id, name, email, image } = session.user;
      response.json({ data: { id, name, email, image: image ?? null } });
    });
  }
  app.use((_request, response) => {
    response.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found." } });
  });
  const handleError: ErrorRequestHandler = (error, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (error instanceof ApiError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error?.type === "encoding.unsupported") {
      response.status(415).json({ error: { code: "UNSUPPORTED_ENCODING", message: "Unsupported request encoding." } });
      return;
    }
    if (error?.type === "entity.too.large") {
      response.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large." } });
      return;
    }
    if (error instanceof ZodError || error?.type === "entity.parse.failed") {
      response.status(400).json({ error: { code: "INVALID_REQUEST", message: "Check your request." } });
      return;
    }
    console.error("TaskFlow API request failed", { code: "INTERNAL_ERROR" });
    response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } });
  };
  app.use(handleError);
  return app;
}

export const app = createApp();

export function createVercelApp(app: ReturnType<typeof express>) {
  let auth: ReturnType<typeof loadAuth> = undefined;
  let storage: AttachmentStorage | undefined;
  try {
    auth = loadAuth();
  } catch {
    console.error("Authentication is unavailable. Check the backend deployment configuration.");
  }

  try {
    storage = loadAttachmentStorage();
  } catch {
    console.error("Attachment storage is unavailable. Check the backend deployment configuration.");
  }

  return createApp(auth, storage, app);
}
