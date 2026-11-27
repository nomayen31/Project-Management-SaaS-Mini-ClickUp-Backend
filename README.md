# Project-Management-SaaS-Mini-ClickUp-Backend

Run `npm ci` to install dependencies. Copy `.env.example` to `.env` and keep that file local. Set `DATABASE_URL` to the Neon pooled connection string for the API and `DIRECT_URL` to the direct connection string for that same database and branch. Preserve the TLS parameters supplied by Neon.

Run `npm run dev` to start the API on port 4000. The development, build, typecheck, and test scripts generate Prisma Client automatically. Run `npm start` after building to start the compiled server.

## Database migrations

Use a separate development or test database or Neon branch. Point both URLs at the intended environment before running database commands.

- `npm run db:validate` validates the Prisma schema.
- `npm run db:migrate:dev -- --name <change>` creates and applies a migration on a development database after a schema change.
- `npm run db:migrate:deploy` applies committed migrations to the configured database.
- `npm run db:migrate:status` checks migration history and status.

The first migration creates the tables for users, sessions, accounts, verification, and auth rate limiting.

## Service endpoints

- `GET /api/health` reports whether Express is running, independent of PostgreSQL.
- `GET /api/ready` runs a PostgreSQL query via Prisma. It returns 200 with `{"data":{"status":"ready","database":"connected"}}` on success, or 503 with error code `DATABASE_UNAVAILABLE` if no database is configured or the query fails.

Run `npm run typecheck`, `npm test`, and `npm run build` to verify the API.

## Authentication

Apply the committed auth migration to an isolated development database with `npm run db:migrate:deploy`. Set `APP_ORIGIN` to the exact public origin that serves Next.js and forwards `/api/auth` to Express. Use HTTPS for deployed environments. For local development, use one hostname consistently, for example `http://localhost:3000`.

Generate a new session secret with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` and store it in the backend environment as `BETTER_AUTH_SECRET`. Set `RESEND_API_KEY` and `AUTH_EMAIL_FROM` with a verified sender to enable email authentication. With Google enabled, register `<APP_ORIGIN>/api/auth/callback/google` as the authorized redirect URI and set both Google variables. Set a fresh `BETTER_AUTH_API_KEY` to enable Dash and enable `AUTH_SENTINEL` only when the Infra plan supports it.

Express handles Better Auth routes at `/api/auth`. `GET /api/auth-providers` exposes only provider availability flags. `GET /api/me` requires a valid cookie-backed session. In local development, the health endpoints remain available when the auth secret is unset.

The backend derives the rate-limit address from its immediate network peer. Configure a trusted ingress address policy before production rollout so users behind the same proxy do not share a rate-limit bucket. Run the auth integration test with `TEST_DATABASE_URL` set to a migrated, isolated PostgreSQL instance.

## Workspaces

The workspace migration adds workspaces, workspace memberships, and invitations. All routes require a verified session. Writes also require the configured app origin.

| Method | Path | Purpose |
| --- | --- | --- |
| GET, POST | `/api/workspaces` | List your workspaces or create one as its owner |
| GET, PATCH | `/api/workspaces/:workspaceId` | View or rename a workspace |
| GET | `/api/workspaces/:workspaceId/members` | View the workspace roster |
| PATCH, DELETE | `/api/workspaces/:workspaceId/members/:userId` | Change a role or remove a member |
| GET, POST | `/api/workspaces/:workspaceId/invitations` | List pending invitations or create a shareable link |
| DELETE | `/api/workspaces/:workspaceId/invitations/:invitationId` | Revoke a pending invitation |
| POST | `/api/workspaces/invitations/accept` | Accept an invitation using its token |

Owners manage admins, members, and viewers. Admins manage members and viewers. Both can rename the workspace. Members and viewers can read workspace details and the roster. Owner membership is protected from role edits and removal.

Invitation links are shared manually. They expire after seven days and can be redeemed once by a verified account with the invited email address. Only the token hash is stored. Creating a replacement invitation generates a new link and invalidates the previous one.

## Projects and tasks

Project endpoints are rooted at `/api/workspaces/:workspaceId/projects`. Use GET or POST on the collection and GET, PATCH, or DELETE at `/:projectId`. Project owners and workspace admins manage project records and team membership. The project team is exposed under `/:projectId/members` with GET and POST, and DELETE at `/:memberId`.

Task collection and detail endpoints use the same methods under `/:projectId/tasks`. Workspace members can edit tasks in projects they have joined. Workspace owners and admins can edit all tasks in their workspace. Viewers have read access. Task participants are managed with PUT and DELETE at `/:taskId/participants/:memberId`, and subtasks are managed with POST, PATCH, or DELETE under `/:taskId/subtasks`.

Collection filters include `status`, `priority`, and `search`. Tasks also support `label`. Set `sort=newest|due|name`, `page` (one-based), and `limit` (1–50). Dates use YYYY-MM-DD on input. Project progress counts tasks with status DONE.

An attachment collection lives at `/:taskId/attachments`. GET lists completed uploads. POST accepts PDF, PNG, or JPEG bytes, up to 3 MiB, with a matching Content-Type and an X-TaskFlow-File-Name header containing the percent-encoded filename. GET at `/:attachmentId/download` checks access before issuing a 60-second signed download URL. DELETE at `/:attachmentId` removes the metadata and queues provider cleanup, including when the task or project is deleted. Set the three Cloudinary variables in the backend environment to enable storage.

### Board and calendar

Use `GET /tasks?sort=board&status=TODO` under a project to read a Kanban column in persisted order. `POST /tasks/:taskId/move` accepts `{ "status": "IN_PROGRESS", "beforeId": null }`. Supply the ID of a task in the destination column to insert before it, or null to append. A stale destination returns HTTP 409. Moves are serialized with other writes to the same workspace.

Use `GET /tasks?from=2026-12-01&to=2026-12-31&sort=due` under a project for tasks whose dates overlap an inclusive calendar range. Both dates are required when filtering. The endpoints use the same workspace permissions and pagination as the task list.

## Deploy the backend to Railway

Connect the backend GitHub repository to an Express service. Railway detects the root Dockerfile. Use the image's default start command. Set the service pre-deploy command to `npm run db:migrate:deploy` and the healthcheck path to `/api/ready`. Railway injects `PORT`; let the app use that port. Pre-deploy migrations run before Railway exposes the new revision.

Set these variables in the backend service environment:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Rotated pooled Neon URL for application queries |
| `DIRECT_URL` | Rotated direct Neon URL for migrations, on the same branch and database |
| `APP_ORIGIN` | Exact public HTTPS origin of the Vercel frontend |
| `BETTER_AUTH_SECRET` | New random server secret of at least 32 characters |
| `RESEND_API_KEY` and `AUTH_EMAIL_FROM` | Resend credentials and verified sender for production email authentication |

Set the optional Google, Better Auth Infra, and Cloudinary variables in the backend service when enabling those integrations. Generate a public HTTPS domain for the Railway service. After the service returns 200 from both `/api/health` and `/api/ready`, set the Vercel frontend's production `BACKEND_ORIGIN` to that Railway origin and redeploy the frontend. Then repeat both checks through the frontend domain.

The runtime image includes Prisma CLI and the committed migrations for the pre-deploy step. Docker's build context includes only the sources and manifests needed to build the app. Credentials belong in Railway service variables.

## Deploy the backend to Vercel

The backend repository includes a Vercel configuration for Express. Its function entry point is the default export in `src/app.ts`. The build generates Prisma Client before Vercel packages the handler.

Use the same backend environment variables listed above. Set `APP_ORIGIN` to the exact Vercel frontend origin and set the frontend's `BACKEND_ORIGIN` to the backend's public HTTPS origin. Apply migrations with `npm run db:migrate:deploy` against the intended production database before enabling auth. Run migrations separately from Vercel builds.

When production auth configuration is incomplete, the Vercel function still serves health and provider status. Authenticated routes are available after the required variables are configured. The Vercel handler does not start a persistent attachment cleanup worker. Run the cleanup worker on a persistent process before enabling production attachments, or provide scheduled cleanup that drains the attachment cleanup queue.
