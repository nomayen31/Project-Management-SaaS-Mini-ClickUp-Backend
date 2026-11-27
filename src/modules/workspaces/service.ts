import { createHash, randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { WorkspaceRole } from "../../generated/prisma/enums.js";
import { ApiError } from "../../lib/api-error.js";

type Role = WorkspaceRole;
type AssignableRole = Exclude<Role, "OWNER">;
type Actor = { id: string; email: string; emailVerified: boolean };
type Transaction = Prisma.TransactionClient;

const workspaceFields = { id: true, name: true, createdAt: true } as const;
const membershipFields = {
  role: true,
  user: { select: { id: true, name: true, image: true } },
} as const;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function requireMembership(db: Transaction, workspaceId: string, userId: string) {
  const membership = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    include: { workspace: { select: workspaceFields } },
  });
  if (!membership) throw new ApiError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
  return membership;
}

function assertManagesRole(actorRole: Role, role: Role) {
  const allowed = role !== "OWNER" && (actorRole === "OWNER" ||
    (actorRole === "ADMIN" && (role === "MEMBER" || role === "VIEWER")));
  if (!allowed) throw new ApiError(403, "FORBIDDEN", "You cannot manage this role.");
}

export function createWorkspaceService(db: PrismaClient) {
  // All membership and invitation writes for a workspace take the same row lock.
  function mutate<T>(workspaceId: string, action: (tx: Transaction) => Promise<T>) {
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "workspace" WHERE "id" = ${workspaceId}::uuid FOR UPDATE`;
      return action(tx);
    });
  }

  return {
    async list(userId: string) {
      const memberships = await db.workspaceMembership.findMany({
        where: { userId },
        orderBy: [{ workspace: { name: "asc" } }, { workspaceId: "asc" }],
        select: { workspace: { select: workspaceFields }, role: true },
      });
      return memberships.map(({ workspace, role }) => ({ ...workspace, role }));
    },

    async create(userId: string, name: string) {
      const workspace = await db.workspace.create({
        data: { name, memberships: { create: { userId, role: "OWNER" } } },
        select: workspaceFields,
      });
      return { ...workspace, role: WorkspaceRole.OWNER };
    },

    async detail(workspaceId: string, userId: string) {
      const { workspace, role } = await requireMembership(db, workspaceId, userId);
      return { ...workspace, role };
    },

    async rename(workspaceId: string, userId: string, name: string) {
      return mutate(workspaceId, async (tx) => {
        const { role } = await requireMembership(tx, workspaceId, userId);
        assertManagesRole(role, "MEMBER");
        const workspace = await tx.workspace.update({
          where: { id: workspaceId }, data: { name }, select: workspaceFields,
        });
        return { ...workspace, role };
      });
    },

    async members(workspaceId: string, userId: string) {
      await requireMembership(db, workspaceId, userId);
      return db.workspaceMembership.findMany({
        where: { workspaceId, workspace: { memberships: { some: { userId } } } }, orderBy: [{ createdAt: "asc" }, { userId: "asc" }], select: membershipFields,
      });
    },

    async manageMember(workspaceId: string, userId: string, targetId: string, role?: AssignableRole) {
      return mutate(workspaceId, async (tx) => {
        const actor = await requireMembership(tx, workspaceId, userId);
        const target = await requireMembership(tx, workspaceId, targetId);
        assertManagesRole(actor.role, target.role);
        const where = { workspaceId_userId: { workspaceId, userId: targetId } };
        if (role === undefined) {
          await tx.workspaceMembership.delete({ where });
          return;
        }

        assertManagesRole(actor.role, role);
        if (role === "VIEWER") {
          await tx.projectMember.deleteMany({ where: { workspaceId, userId: targetId } });
        }
        return tx.workspaceMembership.update({ where, data: { role }, select: membershipFields });
      });
    },

    async invite(workspaceId: string, userId: string, email: string, role: AssignableRole) {
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      return mutate(workspaceId, async (tx) => {
        const actor = await requireMembership(tx, workspaceId, userId);
        assertManagesRole(actor.role, role);
        const member = await tx.workspaceMembership.findFirst({
          where: { workspaceId, user: { email: { equals: email, mode: "insensitive" } } },
          select: { userId: true },
        });
        if (member) throw new ApiError(409, "ALREADY_MEMBER", "This email already belongs to a workspace member.");

        const where = { workspaceId_email: { workspaceId, email } };
        const existing = await tx.workspaceInvitation.findUnique({ where });
        if (existing && !existing.acceptedAt && !existing.revokedAt && existing.expiresAt > new Date()) {
          assertManagesRole(actor.role, existing.role);
        }

        const fields = { role, expiresAt, tokenHash: hashToken(token), invitedById: userId };
        const invitation = await tx.workspaceInvitation.upsert({
          where,
          create: { workspaceId, email, ...fields },
          update: { ...fields, acceptedAt: null, revokedAt: null },
          select: { id: true, email: true, role: true, expiresAt: true },
        });
        return { ...invitation, token };
      });
    },

    async invitations(workspaceId: string, userId: string) {
      const { role } = await requireMembership(db, workspaceId, userId);
      assertManagesRole(role, "MEMBER");
      return db.workspaceInvitation.findMany({
        where: {
          workspaceId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() },
          workspace: { memberships: { some: { userId, role: { in: ["OWNER", "ADMIN"] } } } },
        },
        orderBy: { expiresAt: "asc" },
        select: { id: true, email: true, role: true, expiresAt: true },
      });
    },

    async revokeInvitation(workspaceId: string, userId: string, invitationId: string) {
      return mutate(workspaceId, async (tx) => {
        const actor = await requireMembership(tx, workspaceId, userId);
        assertManagesRole(actor.role, "MEMBER");
        const invitation = await tx.workspaceInvitation.findFirst({
          where: { id: invitationId, workspaceId, acceptedAt: null, revokedAt: null },
        });
        if (!invitation) throw new ApiError(404, "INVITATION_NOT_FOUND", "Invitation not found.");
        assertManagesRole(actor.role, invitation.role);
        await tx.workspaceInvitation.update({
          where: { id: invitationId }, data: { revokedAt: new Date() },
        });
      });
    },

    async accept(token: string, user: Actor) {
      const invalid = () => new ApiError(404, "INVITATION_NOT_FOUND", "This invitation is invalid or expired.");
      if (!user.emailVerified) throw new ApiError(403, "EMAIL_UNVERIFIED", "Verify your email before accepting an invitation.");
      const where = { tokenHash: hashToken(token) };
      const pending = await db.workspaceInvitation.findUnique({ where, select: { workspaceId: true } });
      if (!pending) throw invalid();

      return mutate(pending.workspaceId, async (tx) => {
        const invitation = await tx.workspaceInvitation.findUnique({ where });
        if (!invitation || invitation.revokedAt || invitation.acceptedAt || invitation.expiresAt <= new Date()) throw invalid();
        if (invitation.email !== user.email.toLowerCase()) {
          throw new ApiError(403, "INVITATION_EMAIL_MISMATCH", "Sign in with the invited email address.");
        }

        const workspaceId = invitation.workspaceId;
        await tx.workspaceMembership.upsert({
          where: { workspaceId_userId: { workspaceId, userId: user.id } },
          create: { workspaceId, userId: user.id, role: invitation.role },
          update: {},
        });
        await tx.workspaceInvitation.update({
          where: { id: invitation.id }, data: { acceptedAt: new Date() },
        });
        return { workspaceId };
      });
    },
  };
}
