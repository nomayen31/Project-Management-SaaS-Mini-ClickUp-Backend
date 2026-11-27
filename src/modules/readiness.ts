import { Router } from "express";
import { getDatabase } from "../lib/database.js";

export const readinessRouter = Router();
// Update this when a release introduces a migration required by its API.
const requiredMigration = "20261128020000_account_preferences";

readinessRouter.get("/ready", async (_request, response) => {
  response.set("Cache-Control", "no-store");

  try {
    const database = getDatabase();
    if (database) {
      const [schema] = await database.$queryRaw<{ applied: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM "_prisma_migrations"
          WHERE migration_name = ${requiredMigration}
            AND finished_at IS NOT NULL AND rolled_back_at IS NULL
        ) AS applied
      `;
      if (schema?.applied) {
        response.json({ data: { status: "ready", database: "connected", schema: "current" } });
        return;
      }
    }
  } catch {
    // Keep connection details and driver errors out of the public response.
  }

  response.status(503).json({
    error: { code: "DATABASE_UNAVAILABLE", message: "Database is unavailable." },
  });
});
