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

test("workspace and project isolation, role permissions, and single-use invitations", {
  skip: !testDatabase && "Set TEST_DATABASE_URL to a migrated, isolated PostgreSQL database.",
}, async (context) => {
  assert(testDatabase);
  const db = new PrismaClient({ adapter: new PrismaPg(testDatabase) });
  const uploaded = new Set<string>();
  const workspaceIds: string[] = [];
  const emails: string[] = [];
  context.after(async () => {
    try {
      await db.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      await db.attachmentCleanup.deleteMany({ where: { storageId: { in: [...uploaded] } } });
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
  }, {
    async upload(id) { uploaded.add(id); },
    download(id) { return "https://storage.example/" + id; },
    async remove(id) { uploaded.delete(id); },
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
  const projects = workspace + "/projects";
  const createProject = await request(projects, owner.cookie, "POST", { name: "Launch", dueDate: "2027-01-01" });
  assert.equal(createProject.status, 201);
  const projectId = (await createProject.json()).data.id;
  const project = projects + "/" + projectId;
  const tasks = project + "/tasks";
  assert.equal((await request(`/${otherWorkspaceId}/projects/${projectId}`, outsider.cookie)).status, 404);
  assert.equal((await request(project, viewer.cookie, "PATCH", { name: "Blocked" })).status, 403);
  assert.equal((await request(tasks, viewer.cookie, "POST", { title: "Blocked" })).status, 403);
  assert.equal((await request(project + "/members", owner.cookie, "POST", { userId: outsider.id })).status, 404);
  assert.equal((await request(project + "/members", owner.cookie, "POST", { userId: viewer.id })).status, 400);
  assert.equal((await request(workspace + "/members/" + viewer.id, admin.cookie, "PATCH", { role: "MEMBER" })).status, 200);
  assert.equal((await request(tasks, viewer.cookie, "POST", { title: "Still blocked" })).status, 403);
  assert.equal((await request(project + "/members", admin.cookie, "POST", { userId: viewer.id })).status, 204);

  const taskResponse = await request(tasks, viewer.cookie, "POST", {
    title: "Ship launch", priority: "HIGH", startDate: "2026-12-01", dueDate: "2026-12-15", labels: ["Launch"],
  });
  assert.equal(taskResponse.status, 201);
  const task = tasks + "/" + (await taskResponse.json()).data.id;
  assert.equal((await request(task, viewer.cookie, "PATCH", { dueDate: "2026-11-01" })).status, 400);
  assert.equal((await request(task + "/participants/" + outsider.id, viewer.cookie, "PUT", { role: "ASSIGNEE" })).status, 400);
  assert.equal((await request(task + "/participants/" + viewer.id, viewer.cookie, "PUT", { role: "ASSIGNEE" })).status, 204);
  const subtaskResponse = await request(task + "/subtasks", viewer.cookie, "POST", { title: "Review" });
  assert.equal(subtaskResponse.status, 201);
  const subtaskId = (await subtaskResponse.json()).data.id;
  assert.equal((await request(task + "/subtasks/" + subtaskId, viewer.cookie, "PATCH", { completed: true })).status, 204);
  const result = (await (await request(tasks + "?priority=HIGH&label=Launch&sort=due&limit=1", viewer.cookie)).json()).data;
  assert.equal(result.total, 1);
  assert.equal(result.items[0].participants[0].user.id, viewer.id);
  assert.equal(result.items[0].subtasks[0].completed, true);
  const firstTaskId = task.split("/").at(-1);
  assert(firstTaskId);
  const second = await request(tasks, viewer.cookie, "POST", { title: "Second task", dueDate: "2026-12-10" });
  assert.equal(second.status, 201);
  const secondId = (await second.json()).data.id;
  const third = await request(tasks, viewer.cookie, "POST", { title: "Third task" });
  assert.equal(third.status, 201);
  const thirdId = (await third.json()).data.id;

  async function boardIds(status: string) {
    const result = await request(tasks + "?sort=board&status=" + status, owner.cookie);
    assert.equal(result.status, 200);
    return (await result.json()).data.items.map((item: { id: string }) => item.id);
  }
  assert.deepEqual(await boardIds("TODO"), [firstTaskId, secondId, thirdId]);
  assert.equal((await request(tasks + "/" + thirdId + "/move", viewer.cookie, "POST", { status: "TODO", beforeId: firstTaskId })).status, 204);
  assert.deepEqual(await boardIds("TODO"), [thirdId, firstTaskId, secondId]);
  assert.equal((await request(task + "/move", viewer.cookie, "POST", { status: "IN_REVIEW", beforeId: secondId })).status, 409);
  assert.equal((await request(task + "/move", viewer.cookie, "POST", { status: "IN_REVIEW", beforeId: null })).status, 204);
  assert.deepEqual(await boardIds("TODO"), [thirdId, secondId]);
  assert.deepEqual(await boardIds("IN_REVIEW"), [firstTaskId]);

  const calendarRange = await request(tasks + "?from=2026-12-09&to=2026-12-11", owner.cookie);
  assert.equal(calendarRange.status, 200);
  const scheduled = (await calendarRange.json()).data.items.map((item: { id: string }) => item.id);
  assert(scheduled.includes(firstTaskId) && scheduled.includes(secondId) && !scheduled.includes(thirdId));
  assert.equal((await request(tasks + "?from=2026-12-09", owner.cookie)).status, 400);
  assert.equal((await request(tasks + "?from=2026-12-09&to=2027-12-09", owner.cookie)).status, 400);
  const attachmentBase = task + "/attachments";
  function upload(contents: string, cookie: string, mediaType = "application/pdf") {
    return fetch(`${origin}/api/workspaces${attachmentBase}`, {
      method: "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": mediaType, "X-TaskFlow-File-Name": "launch.pdf" },
      body: contents,
    });
  }
  assert.equal((await upload("invalid", owner.cookie)).status, 415);
  assert.equal((await upload("%PDF-fixture", outsider.cookie)).status, 404);
  const attached = await upload("%PDF-fixture", viewer.cookie);
  assert.equal(attached.status, 201);
  const attachmentId = (await attached.json()).data.id;
  const savedAttachment = await db.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
  assert.equal(savedAttachment.ready, true);
  assert(uploaded.has(savedAttachment.storageId));
  const download = async (cookie: string) => fetch(`${origin}/api/workspaces${attachmentBase}/${attachmentId}/download`, {
    redirect: "manual", headers: { Cookie: cookie },
  });
  assert.equal((await download(outsider.cookie)).status, 404);
  assert.equal((await download(viewer.cookie)).status, 302);
  const listed = (await (await request(attachmentBase, owner.cookie)).json()).data.items;
  assert.equal(listed.length, 1);
  assert(!("storageId" in listed[0]));
  assert.equal((await request(task, viewer.cookie, "PATCH", { status: "DONE" })).status, 200);
  assert.equal((await (await request(project, owner.cookie)).json()).data.completedTasks, 1);
  assert.equal((await request(workspace + "/members/" + viewer.id, admin.cookie, "PATCH", { role: "VIEWER" })).status, 200);
  assert.equal((await (await request(task, owner.cookie)).json()).data.participants.length, 0);
  assert.equal((await request(task + "/move", viewer.cookie, "POST", { status: "TODO", beforeId: null })).status, 403);
  assert.equal((await request(task, viewer.cookie, "DELETE")).status, 403);
  assert.equal((await request(task, owner.cookie, "DELETE")).status, 204);
  assert(await db.attachmentCleanup.findUnique({ where: { storageId: savedAttachment.storageId } }));
  assert.equal((await request(project, admin.cookie, "DELETE")).status, 204);
  assert.equal((await request(project, owner.cookie)).status, 404);
  assert.equal((await request(workspace + "/members/" + admin.id, owner.cookie, "PATCH", { role: "OWNER" })).status, 400);
  assert.equal((await request(workspace + "/members/" + viewer.id, admin.cookie, "DELETE")).status, 204);
  assert.equal((await request(workspace, viewer.cookie)).status, 404);
});
