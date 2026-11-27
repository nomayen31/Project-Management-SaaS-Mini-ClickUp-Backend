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
