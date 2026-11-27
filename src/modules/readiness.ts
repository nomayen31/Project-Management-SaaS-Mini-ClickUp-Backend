import { Router } from "express";
import { getDatabase } from "../lib/database.js";

export const readinessRouter = Router();

readinessRouter.get("/ready", async (_request, response) => {
  response.set("Cache-Control", "no-store");

  try {
    const database = getDatabase();
    if (database) {
      await database.$queryRaw`SELECT 1`;
      response.json({ data: { status: "ready", database: "connected" } });
      return;
    }
  } catch {
    // Keep connection details and driver errors out of the public response.
  }

  response.status(503).json({
    error: { code: "DATABASE_UNAVAILABLE", message: "Database is unavailable." },
  });
});
