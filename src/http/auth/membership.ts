import type { FactoreePrismaClient } from "~/persistence/prisma/client.js";

/** What Linear reports about the user who signs in. */
export interface LinearViewer {
  id: string;
  admin: boolean;
  organizationId: string;
}

export interface Membership {
  tenantId: string;
  linearWorkspaceId: string;
  workspaceName: string;
  /** A Linear workspace admin is a Factoree admin of that workspace. */
  admin: boolean;
}

/** The person or the API key behind one administration call. */
export interface Principal {
  userId: string;
  /** Set when the call carried an API key. */
  apiKeyId: string | null;
  memberships: Membership[];
  /** True when the user is an admin of the tenant that ran setup. Only that admin changes install settings. */
  operatorAdmin: boolean;
}

/** Refuses the sign-in of a Linear account that is no member of a set-up workspace. */
export class NotAMemberError extends Error {
  constructor() {
    super("This Linear account is not a member of a workspace that Factoree is installed in.");
    this.name = "NotAMemberError";
  }
}

/**
 * docs/specs/release-0-1-0.md. Records what Linear reported at sign-in. A viewer of a workspace
 * that holds no Factoree installation loses any membership it had, so a user who left the
 * workspace, or moved to another one, is refused at the hook.
 */
export const recordLinearMember = async (prisma: FactoreePrismaClient, viewer: LinearViewer): Promise<void> => {
  const tenant = await prisma.tenant.findUnique({ where: { linearWorkspaceId: viewer.organizationId } });
  if (tenant === null) {
    await prisma.linearMember.deleteMany({ where: { linearUserId: viewer.id } });
    return;
  }
  await prisma.linearMember.upsert({
    where: { linearUserId: viewer.id },
    create: { linearUserId: viewer.id, tenantId: tenant.id, admin: viewer.admin },
    update: { tenantId: tenant.id, admin: viewer.admin, checkedAt: new Date() },
  });
};

/**
 * The hook of the sign-in. better-auth calls it before it creates a Linear account row and
 * before it creates a session, so an outsider gets neither.
 */
export const admitLinearAccount = async (prisma: FactoreePrismaClient, linearUserId: string): Promise<void> => {
  const member = await prisma.linearMember.findUnique({ where: { linearUserId } });
  if (member === null) throw new NotAMemberError();
};

export const admitUser = async (prisma: FactoreePrismaClient, userId: string): Promise<void> => {
  const accounts = await prisma.account.findMany({ where: { userId, providerId: "linear" }, select: { accountId: true } });
  const count = await prisma.linearMember.count({
    where: { linearUserId: { in: accounts.map((account) => account.accountId) } },
  });
  if (count === 0) throw new NotAMemberError();
};

/** The memberships of a user, read for each call, so a sign-in that changed them applies at once. */
export const principalFor = async (
  prisma: FactoreePrismaClient,
  userId: string,
  apiKeyId: string | null,
  operatorTenantId: string | null,
): Promise<Principal | null> => {
  const accounts = await prisma.account.findMany({ where: { userId, providerId: "linear" }, select: { accountId: true } });
  if (accounts.length === 0) return null;
  const members = await prisma.linearMember.findMany({
    where: { linearUserId: { in: accounts.map((account) => account.accountId) } },
    include: { tenant: true },
  });
  if (members.length === 0) return null;
  const memberships = members.map((member) => ({
    tenantId: member.tenantId,
    linearWorkspaceId: member.tenant.linearWorkspaceId,
    workspaceName: member.tenant.name,
    admin: member.admin,
  }));
  return {
    userId,
    apiKeyId,
    memberships,
    operatorAdmin: memberships.some((membership) => membership.admin && membership.tenantId === operatorTenantId),
  };
};
