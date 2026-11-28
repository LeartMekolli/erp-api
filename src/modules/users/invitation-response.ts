import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client';

/** What became of an invitation's email: `sent` once any delivery went out, `failed` when none can, else `sending`. */
export const INVITATION_EMAIL_STATUSES = ['sending', 'sent', 'failed'] as const;
export type InvitationEmailStatus = (typeof INVITATION_EMAIL_STATUSES)[number];

/** A staff invitation as the people settings show it. Never the token. */
export const invitationResponseSchema = z.strictObject({
  id: z.uuid(),
  email: z.string(),
  role: z.strictObject({ id: z.uuid(), name: z.string() }),
  invited_by: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  status: z.enum(['waiting', 'expired']),
  created_at: z.string(),
  expires_at: z.string(),
  // Null when no email was raised for it (older invitations, or the platform invited the owner).
  email_status: z.enum(INVITATION_EMAIL_STATUSES).nullable(),
});
export type InvitationResponse = z.infer<typeof invitationResponseSchema>;

export interface InvitationRow {
  id: string;
  email: string;
  expiresAt: Date;
  createdAt: Date;
  role: { id: string; name: string };
  invitedBy: { id: string; name: string } | null;
}

export function toInvitationResponse(
  row: InvitationRow,
  emailStatus: InvitationEmailStatus | null,
  now: Date,
): InvitationResponse {
  return {
    id: row.id,
    email: row.email,
    role: { id: row.role.id, name: row.role.name },
    invited_by: row.invitedBy ? { id: row.invitedBy.id, name: row.invitedBy.name } : null,
    status: row.expiresAt > now ? 'waiting' : 'expired',
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
    email_status: emailStatus,
  };
}

/**
 * The email status of each invitation that has a `user.invited` notification. An invitation without one is
 * absent from the map.
 */
export async function emailStatusOf(
  tx: Prisma.TransactionClient,
  invitationIds: string[],
): Promise<Map<string, InvitationEmailStatus>> {
  const result = new Map<string, InvitationEmailStatus>();
  if (invitationIds.length === 0) {
    return result;
  }
  const notifications = await tx.notification.findMany({
    where: { subjectType: 'invitation', eventKey: 'user.invited', subjectId: { in: invitationIds } },
    select: { id: true, subjectId: true, status: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const deliveries = await tx.notificationDelivery.findMany({
    where: { notificationId: { in: notifications.map((notification) => notification.id) } },
    select: { notificationId: true, status: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  for (const notification of notifications) {
    const own = deliveries.filter((delivery) => delivery.notificationId === notification.id);
    const latest = own.at(-1);
    let status: InvitationEmailStatus;
    if (own.some((delivery) => delivery.status === 'sent')) {
      status = 'sent';
    } else if (latest?.status === 'failed' || notification.status === 'failed') {
      status = 'failed';
    } else {
      status = 'sending';
    }
    // Several notifications for one invitation (a re-raise): the newest wins, as they are read oldest first.
    result.set(notification.subjectId, status);
  }
  return result;
}
