import type { Prisma } from '../../generated/prisma/client';
import type { SettingsService } from '../settings/settings.service';
import { localDate } from './dates';
import type { BusinessCalendar } from './dates';
import { needsDay } from './needs';
import type { NeedsDay } from './needs';
import { DEFAULT_CALENDAR } from './place-order';

type Tx = Prisma.TransactionClient;

/** The workspace's `business.calendar` setting, or the default one. */
export async function workspaceCalendar(tx: Tx, settings: SettingsService): Promise<BusinessCalendar> {
  return ((await settings.list(tx))['business.calendar'] as BusinessCalendar | undefined) ?? DEFAULT_CALENDAR;
}

/**
 * The workspace's today in its time zone and the due-soon window on its calendar: what late and due soon
 * compare with, for orders and partners' jobs alike.
 */
export async function needsToday(tx: Tx, tenantId: string, settings: SettingsService, now: Date = new Date()): Promise<NeedsDay> {
  const { timezone } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
  return needsDay(localDate(now, timezone), await workspaceCalendar(tx, settings));
}
