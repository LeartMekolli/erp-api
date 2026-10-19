import type { Notification, Prisma } from '../../generated/prisma/client';
import { SettingsService } from '../settings/settings.service';
import { EVENTS, EventKey } from './catalogue';

/** One address a notification goes to; `userId` when it is a user, who also gets a feed entry. */
export interface Target {
  userId?: string;
  email: string;
  locale: string;
}

/**
 * Who a notification reaches (D71, plan N4), decided here from the event and
 * its subject — never by the caller (D68). Only active users count, and each
 * address appears once even if it qualifies twice.
 */
export async function resolveAudience(
  tx: Prisma.TransactionClient,
  notification: Pick<Notification, 'tenantId' | 'eventKey' | 'subjectId'>,
  settings: SettingsService,
): Promise<Target[]> {
  const event = notification.eventKey as EventKey;
  const audience = EVENTS[event].audience;
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: notification.tenantId } });
  const targets: Target[] = [];

  switch (audience.kind) {
    case 'invitee': {
      const invitation = await tx.invitation.findFirst({ where: { id: notification.subjectId } });
      if (invitation) {
        targets.push({ email: invitation.email, locale: tenant.defaultLocale });
      }
      break;
    }
    case 'user': {
      const user = await tx.user.findFirst({ where: { id: notification.subjectId, status: 'active' } });
      if (user) {
        targets.push({ userId: user.id, email: user.email, locale: user.locale });
      }
      break;
    }
    case 'permission': {
      const holders = await tx.user.findMany({
        where: {
          status: 'active',
          roles: { some: { role: { permissions: { some: { permission: audience.permission } } } } },
        },
        orderBy: { id: 'asc' },
      });
      targets.push(...holders.map((user) => ({ userId: user.id, email: user.email, locale: user.locale })));

      // Extra addresses staff configured for this event (D71, setting notification.staffRecipients).
      const configured = (await settings.list(tx))['notification.staffRecipients'] as
        | { byEvent: Record<string, string[]> }
        | undefined;
      for (const email of configured?.byEvent[event] ?? []) {
        targets.push({ email, locale: tenant.defaultLocale });
      }
      break;
    }
  }

  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = target.email.trim().toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
