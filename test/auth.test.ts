import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";

const testDatabase = process.env.TEST_DATABASE_URL;

test("verified authentication, password reset, and cookie session lifecycle", {
  skip: !testDatabase && "Set TEST_DATABASE_URL to a migrated, isolated PostgreSQL database.",
}, async (context) => {
  assert(testDatabase);
  const db = new PrismaClient({ adapter: new PrismaPg(testDatabase) });
  const email = `taskflow-${randomUUID()}@example.com`;
  context.after(async () => {
    try {
      await db.user.deleteMany({ where: { email } });
    } finally {
      await db.$disconnect();
    }
  });

  let app: ReturnType<typeof createApp>;
  const server = createServer((request, response) => app(request, response));
  server.listen(0, "127.0.0.1");
  context.after(() => { server.close(); });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const emails: string[] = [];
  const auth = createAuth({
    APP_ORIGIN: origin,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    AUTH_SENTINEL: "false",
  }, db, async (mail) => { emails.push(mail.text); });
  app = createApp({ instance: auth, providers: { email: true, google: false, dash: false, sentinel: false } });

  function post(path: string, body: object, cookie = "", requestOrigin = origin) {
    return fetch(`${origin}/api/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: requestOrigin, Cookie: cookie },
      body: JSON.stringify(body),
      redirect: "manual",
    });
  }

  const password = "Test-only-password-123!";
  assert.equal((await fetch(`${origin}/api/me`)).status, 401);
  assert.equal((await post("sign-up/email", { name: "Test user", email, password }, "", "https://untrusted.example")).status, 403);
  assert.equal((await post("sign-up/email", { name: "Test user", email, password, callbackURL: "/auth" })).status, 200);
  assert.equal((await post("sign-in/email", { email, password })).status, 403);
  assert.equal(emails.length, 1);

  const verifyURL = emails[0].match(/https?:\/\/\S+/)?.[0];
  assert(verifyURL);
  assert.equal((await fetch(verifyURL, { redirect: "manual" })).status, 302);
  const login = await post("sign-in/email", { email, password });
  assert.equal(login.status, 200);
  const sessionCookie = login.headers.getSetCookie().find((entry) => entry.includes("session_token="));
  assert(sessionCookie);
  assert.match(sessionCookie, /HttpOnly/i);
  assert.match(sessionCookie, /SameSite=Lax/i);
  const cookie = sessionCookie.split(";")[0];
  const profile = await fetch(`${origin}/api/me`, { headers: { Cookie: cookie } });
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).data.email, email);

  assert.equal((await post("request-password-reset", { email, redirectTo: "/auth?mode=reset" })).status, 200);
  assert.equal(emails.length, 2);
  const resetURL = emails[1].match(/https?:\/\/\S+/)?.[0];
  assert(resetURL);
  const resetLink = await fetch(resetURL, { redirect: "manual" });
  assert.equal(resetLink.status, 302);
  const location = resetLink.headers.get("location");
  assert(location);
  const token = new URL(location, origin).searchParams.get("token");
  assert(token);
  const newPassword = "Updated-test-password-123!";
  assert.equal((await post("reset-password", { token, newPassword })).status, 200);
  assert.equal((await fetch(`${origin}/api/me`, { headers: { Cookie: cookie } })).status, 401);

  const newLogin = await post("sign-in/email", { email, password: newPassword });
  assert.equal(newLogin.status, 200);
  assert.equal((await post("sign-in/email", { email, password })).status, 429);
  const newCookie = newLogin.headers.getSetCookie().find((entry) => entry.includes("session_token="))?.split(";")[0];
  assert(newCookie);
  assert.equal((await post("sign-out", {}, newCookie)).status, 200);
  assert.equal((await fetch(`${origin}/api/me`, { headers: { Cookie: newCookie } })).status, 401);
});
