import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { disconnectDatabase } from "../src/lib/database.js";
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

test("readiness confirms a migrated database", {
  skip: !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL to a migrated, isolated PostgreSQL database.",
}, async (context) => {
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;
  const server = app.listen(0, "127.0.0.1");
  context.after(async () => {
    server.close();
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
    await disconnectDatabase();
  });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/ready`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { status: "ready", database: "connected", schema: "current" } });
});
