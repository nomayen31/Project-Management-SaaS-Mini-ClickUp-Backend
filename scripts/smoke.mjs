import assert from "node:assert/strict";

function parseOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Provide a valid HTTPS origin."); }
  assert(url.origin === value, "Provide an origin without credentials, a path, or a trailing slash.");
  assert.equal(url.protocol, "https:", "Smoke checks require HTTPS.");
  return url.origin;
}

const [frontend, backend] = process.argv.slice(2).map(parseOrigin);
assert(frontend && backend, "Usage: npm run smoke -- <frontend-origin> <backend-origin>");

async function response(origin, path) {
  const result = await fetch(origin + path, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  assert.equal(result.status, 200, `${origin}${path} returned HTTP ${result.status}`);
  return result;
}

async function checkApi(origin) {
  const health = await (await response(origin, "/api/health")).json();
  assert.deepEqual(health.data, { status: "ok", service: "taskflow-api" });

  const readiness = await (await response(origin, "/api/ready")).json();
  assert.deepEqual(readiness.data, { status: "ready", database: "connected", schema: "current" });

  const { data } = await (await response(origin, "/api/auth-providers")).json();
  assert(data?.email === true || data?.google === true, `No sign-in provider enabled at ${origin}`);

  const protectedProfile = await fetch(origin + "/api/me", { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  assert.equal(protectedProfile.status, 401, `Expected unauthenticated access to be rejected at ${origin}`);
}

for (const path of ["/", "/auth", "/workspaces", "/projects"]) {
  const page = await response(frontend, path);
  assert(page.headers.get("content-type")?.includes("text/html"), `${path} did not return HTML`);
}

await Promise.all([checkApi(frontend), checkApi(backend)]);
console.log("Frontend pages, direct API, frontend API proxy, schema readiness, and session access checks passed.");
