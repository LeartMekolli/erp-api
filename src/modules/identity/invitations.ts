import type { Prisma } from '../../generated/prisma/client';
import { issueOpaqueToken } from './opaque-token';

/** Plan 2, P4. */
export const INVITATION_DAYS = 7;

/**
 * Creates a single-use invitation in the transaction's tenant and returns the
 * token for the notifier. Earlier pending invitations for the same email are
 * expired, so only the newest link works. The caller notifies after commit.
 */
export async function createInvitation(
  tx: Prisma.TransactionClient,
  tenantId: string,
  input: { email: string; roleId: string; invitedByUserId?: string },
): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
  const now = new Date();

  await tx.invitation.updateMany({
    where: { email: input.email, acceptedAt: null, expiresAt: { gt: now } },
    data: { expiresAt: now },
  });

  const { token, hash } = issueOpaqueToken(tenantId);
  const expiresAt = new Date(now.getTime() + INVITATION_DAYS * 24 * 60 * 60 * 1000);
  const invitation = await tx.invitation.create({
    data: {
      email: input.email,
      roleId: input.roleId,
      tokenHash: hash,
      invitedByUserId: input.invitedByUserId,
      expiresAt,
    },
  });

  return { invitationId: invitation.id, token, expiresAt };
}
