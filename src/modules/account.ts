import { fromNodeHeaders } from "better-auth/node";
import { json, Router } from "express";
import { z } from "zod";
import type { loadAuth } from "../auth.js";
import { ApiError } from "../lib/api-error.js";

type Config = NonNullable<ReturnType<typeof loadAuth>>;
const preference = z.object({ mentionNotifications: z.boolean() }).strict();

export function accountRouter(auth: Config["instance"], { database, origin }: Config["workspace"]) {
  const router = Router();

  async function currentUser(headers: Parameters<typeof fromNodeHeaders>[0]) {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (!session) throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
    return session.user.id;
  }

  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  router.get("/settings", async (req, res) => {
    const id = await currentUser(req.headers);
    const data = await database.user.findUniqueOrThrow({ where: { id }, select: { mentionNotifications: true } });
    res.json({ data });
  });

  router.patch("/settings", json({ limit: "4kb" }), async (req, res) => {
    if (req.get("origin") !== origin) throw new ApiError(403, "INVALID_ORIGIN", "This request origin is not allowed.");
    const id = await currentUser(req.headers);
    const data = await database.user.update({
      where: { id }, data: preference.parse(req.body), select: { mentionNotifications: true },
    });
    res.json({ data });
  });

  return router;
}
