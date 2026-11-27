import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { app } from "../src/app.js";

test("the API returns health and consistent errors for unconfigured database and missing routes", async (context) => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  context.after(() => {
    if (originalDatabaseUrl !== undefined) process.env.DATABASE_URL = originalDatabaseUrl;
  });

  const server = app.listen(0, "127.0.0.1");
  context.after(() => { server.close(); });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  assert.equal(health.headers.get("x-powered-by"), null);
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.deepEqual(await health.json(), { data: { status: "ok", service: "taskflow-api" } });

  const readiness = await fetch(`${base}/api/ready`);
  assert.equal(readiness.status, 503);
  assert.equal(readiness.headers.get("cache-control"), "no-store");
  assert.deepEqual(await readiness.json(), {
    error: { code: "DATABASE_UNAVAILABLE", message: "Database is unavailable." },
  });

  const missing = await fetch(`${base}/api/missing`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: { code: "NOT_FOUND", message: "Route not found." } });
});
