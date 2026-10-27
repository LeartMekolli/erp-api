import type { PrismaService } from '../database/prisma.service';
import { SettingsService } from '../modules/settings/settings.service';

// Demo ordering setup for the demo workspace, on top of its catalog and pricing (`seed-catalog.ts`,
// `seed-pricing.ts`): two shipping methods, a default tax rate and one country's, and the working
// week promised dates count by.

const SHIPPING_METHODS = [
  { key: 'courier', name: 'Standard courier', price: '9.90' },
  { key: 'collect', name: 'Collect at the workshop', price: '0' },
];
const TAX_RATES = [
  { country: null, region: null, percent: '0' },
  { country: 'DE', region: null, percent: '19' },
];
const CALENDAR = { workingDays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17, closedDates: [] };
// A partner's job is due 2 working days before the order's promised date, 1 more for a part of an assembly.
const SCHEDULING = { bufferDays: 2, assemblyAllowanceDays: 1 };

export interface OrdersSeedCounts {
  shippingMethods: number;
  taxRates: number;
  /** 1 when the calendar was set, 0 when the workspace had one. */
  calendar: number;
  /** 1 when the job due-date setting was set, 0 when the workspace had one. */
  scheduling: number;
}

/**
 * Seeds the demo ordering setup into one workspace. Idempotent: a shipping method is found by key,
 * a tax rate by country and region, and the calendar and job due dates by their settings; anything found is left as it is.
 */
export async function seedOrders(prisma: PrismaService, tenantId: string): Promise<OrdersSeedCounts> {
  const created: OrdersSeedCounts = { shippingMethods: 0, taxRates: 0, calendar: 0, scheduling: 0 };

  await prisma.inTenant(tenantId, async (tx) => {
    for (const method of SHIPPING_METHODS) {
      if (await tx.shippingMethod.findFirst({ where: { key: method.key } })) continue;
      await tx.shippingMethod.create({ data: method });
      created.shippingMethods++;
    }

    for (const rate of TAX_RATES) {
      if (await tx.taxRate.findFirst({ where: { country: rate.country, region: rate.region } })) continue;
      await tx.taxRate.create({ data: rate });
      created.taxRates++;
    }

    if (!(await tx.tenantSetting.findFirst({ where: { key: 'business.calendar' } }))) {
      await new SettingsService().set(tx, 'business.calendar', CALENDAR);
      created.calendar++;
    }

    if (!(await tx.tenantSetting.findFirst({ where: { key: 'orders.scheduling' } }))) {
      await new SettingsService().set(tx, 'orders.scheduling', SCHEDULING);
      created.scheduling++;
    }
  });

  return created;
}
