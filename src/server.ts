import { z } from "zod";
import { createApp } from "./app.js";
import { loadAuth } from "./auth.js";
import { disconnectDatabase } from "./lib/database.js";

const port = z.coerce.number().int().min(1).max(65535).parse(process.env.PORT ?? 4000);
const server = createApp(loadAuth()).listen(port, () => console.log(`TaskFlow API listening on port ${port}`));

function shutdown() {
  server.close(async () => {
    try {
      await disconnectDatabase();
    } catch {
      console.error("Could not close the database connection.");
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
