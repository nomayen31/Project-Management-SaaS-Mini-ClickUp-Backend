import { Router } from "express";

export const healthRouter = Router();
healthRouter.get("/health", (_request, response) => {
  response.set("Cache-Control", "no-store");
  response.json({ data: { status: "ok", service: "taskflow-api" } });
});
