import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../src/app.js";
import { loadAuth } from "../src/auth.js";
import { disconnectDatabase } from "../src/lib/database.js";

test("production can offer Google sign-in without opening password registration", async (context) => {
  const originalEnv = process.env;
  process.env = {
    NODE_ENV: "production",
    APP_ORIGIN: "https://taskflow.example",
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:1/test",
  };
  context.after(async () => {
    process.env = originalEnv;
    await disconnectDatabase();
  });

  assert.throws(() => loadAuth(), /requires SMTP or Google OAuth/);
  process.env.GOOGLE_CLIENT_ID = "fixture.apps.googleusercontent.com";
  assert.throws(() => loadAuth(), /Invalid TaskFlow authentication configuration/);
  process.env.GOOGLE_CLIENT_SECRET = "fixture-only";
  const auth = loadAuth();
  assert(auth);
  const server = createApp(auth).listen(0, "127.0.0.1");
  context.after(() => { server.close(); });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");

  const response = await fetch(`http://127.0.0.1:${address.port}/api/auth-providers`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { email: false, google: true, dash: false, sentinel: false });
});
