import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";

const testDatabase = process.env.TEST_DATABASE_URL;

test("workspace permissions and single-use invitations", {
  skip: !testDatabase && "Set TEST_DATABASE_URL to a migrated, isolated PostgreSQL database.",
}, async (context) => {
  assert(testDatabase);
  const db = new PrismaClient({ adapter: new PrismaPg(testDatabase) });
  const workspaceIds: string[] = [];
  const emails: string[] = [];
  context.after(async () => {
    try {
      await db.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      await db.user.deleteMany({ where: { email: { in: emails } } });
    } finally { await db.$disconnect(); }
  });

  let app: ReturnType<typeof createApp>;
  const server = createServer((request, response) => app(request, response));
  server.listen(0, "127.0.0.1");
  context.after(() => { server.close(); });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const auth = createAuth({
    APP_ORIGIN: origin, BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"), AUTH_SENTINEL: "false",
  }, db, async () => {});
  app = createApp({
    instance: auth, workspace: { database: db, origin },
    providers: { email: true, google: false, dash: false, sentinel: false },
  });

  async function user(name: string) {
    const email = `${randomUUID()}@example.com`;
    emails.push(email);
    const password = "Test-only-password-123!";
    const signup = await auth.api.signUpEmail({ body: { name, email, password } });
    await db.user.update({ where: { id: signup.user.id }, data: { emailVerified: true } });
    const login = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
    const cookie = login.headers.getSetCookie().find((entry) => entry.includes("session_token="))?.split(";")[0];
    assert(cookie);
    return { id: signup.user.id, email, cookie };
  }

  function request(path: string, cookie = "", method = "GET", body?: object, requestOrigin = origin) {
    return fetch(`${origin}/api/workspaces${path}`, {
      method,
      headers: { Cookie: cookie, Origin: requestOrigin, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function createWorkspace(cookie: string) {
    const response = await request("", cookie, "POST", { name: "Product team" });
    assert.equal(response.status, 201);
    const { data } = await response.json();
    workspaceIds.push(data.id);
    assert.equal(data.role, "OWNER");
    return String(data.id);
  }

  const owner = await user("Owner");
  const admin = await user("Admin");
  const viewer = await user("Viewer");
  const outsider = await user("Outsider");

  assert.equal((await request("")).status, 401);
  assert.equal((await request("", owner.cookie, "POST", { name: "Blocked" }, "https://untrusted.example")).status, 403);
  const workspaceId = await createWorkspace(owner.cookie);
  const otherWorkspaceId = await createWorkspace(outsider.cookie);
  const workspace = `/${workspaceId}`;
  assert.equal((await request(workspace, outsider.cookie)).status, 404);
  assert.equal((await request(`/${otherWorkspaceId}/members`, owner.cookie)).status, 404);
  const ownerWorkspaces = await (await request("", owner.cookie)).json();
  assert.deepEqual(ownerWorkspaces.data.map((item: { id: string }) => item.id), [workspaceId]);

  async function invite(email: string, role: string, cookie = owner.cookie) {
    const response = await request(workspace + "/invitations", cookie, "POST", { email, role });
    assert.equal(response.status, 201);
    return (await response.json()).data as { id: string; token: string };
  }

  const adminInvite = await invite(admin.email.toUpperCase(), "ADMIN");
  assert.equal((await request("/invitations/accept", outsider.cookie, "POST", { token: adminInvite.token })).status, 403);
  const concurrent = await Promise.all([
    request("/invitations/accept", admin.cookie, "POST", { token: adminInvite.token }),
    request("/invitations/accept", admin.cookie, "POST", { token: adminInvite.token }),
  ]);
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 404]);
  assert.equal((await request(workspace + "/invitations", admin.cookie, "POST", { email: viewer.email, role: "ADMIN" })).status, 403);
  assert.equal((await request(workspace + "/members/" + owner.id, admin.cookie, "DELETE")).status, 403);

  const revoked = await invite(viewer.email, "VIEWER", admin.cookie);
  assert.equal((await request(workspace + "/invitations/" + revoked.id, admin.cookie, "DELETE")).status, 204);
  assert.equal((await request("/invitations/accept", viewer.cookie, "POST", { token: revoked.token })).status, 404);
  const valid = await invite(viewer.email, "VIEWER", admin.cookie);
  assert.notEqual(valid.token, revoked.token);
  const outstanding = await (await request(workspace + "/invitations", owner.cookie)).json();
  assert.equal(outstanding.data[0].id, valid.id);
  assert(!("token" in outstanding.data[0]) && !("tokenHash" in outstanding.data[0]));
  assert.equal((await request("/invitations/accept", viewer.cookie, "POST", { token: valid.token })).status, 200);
  assert.equal((await request(workspace + "/members", viewer.cookie)).status, 200);
  assert.equal((await request(workspace + "/invitations", viewer.cookie)).status, 403);
  assert.equal((await request(workspace, viewer.cookie, "PATCH", { name: "Blocked" })).status, 403);
  assert.equal((await request(workspace, admin.cookie, "PATCH", { name: "New name" })).status, 200);
  assert.equal((await request(workspace + "/members/" + viewer.id, admin.cookie, "PATCH", { role: "MEMBER" })).status, 200);
  assert.equal((await request(workspace + "/members/" + admin.id, owner.cookie, "PATCH", { role: "OWNER" })).status, 400);
  assert.equal((await request(workspace + "/members/" + viewer.id, admin.cookie, "DELETE")).status, 204);
  assert.equal((await request(workspace, viewer.cookie)).status, 404);
});
