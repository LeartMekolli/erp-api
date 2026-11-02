import { randomBytes } from 'node:crypto';
import type { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import type { Address } from '../modules/orders/order-response';
import { hashPassword } from '../modules/identity/passwords';
import type { SettingValue } from '../modules/settings/setting-keys';
import { SettingsService } from '../modules/settings/settings.service';

// Demo customers for the demo workspace, on top of its catalog and pricing (`seed-catalog.ts`,
// `seed-pricing.ts`): Luna Jewels gets the trade group, a head office to bill and a VAT number; Mira
// Studio no group, and is billed where it ships. Priority bands: Gold and Silver (Customers 2).

const CUSTOMERS: {
  name: string;
  group: string | null;
  shipping: Address;
  billing: Address | null;
  vatNumber: string | null;
  people: { email: string; name: string; role: string }[];
}[] = [
  {
    name: 'Luna Jewels',
    group: 'trade',
    shipping: { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
    billing: { name: 'Luna Jewels GmbH', line1: 'Ringstraße 4', city: 'Wien', postal_code: '1010', region: 'Wien', country: 'AT' },
    vatNumber: 'ATU12345678',
    people: [
      { email: 'anna@luna.example.test', name: 'Anna', role: 'owner' },
      { email: 'ben@luna.example.test', name: 'Ben', role: 'buyer' },
    ],
  },
  {
    name: 'Mira Studio',
    group: null,
    shipping: { name: 'Mira Studio', line1: 'Via Roma 2', city: 'Milano', postal_code: '20121', country: 'IT' },
    billing: null,
    vatNumber: null,
    people: [{ email: 'mira@mira.example.test', name: 'Mira', role: 'owner' }],
  },
];

const PRIORITY: SettingValue<'customers.priority'> = {
  weights: { lifetime: 2, recent: 2, frequency: 1, payment: 1 },
  defaultBand: { key: 'standard', name: 'Standard' },
  bands: [
    { key: 'gold', name: 'Gold', from: 80, firstInLine: true, mayPickPartner: true },
    { key: 'silver', name: 'Silver', from: 50, firstInLine: false, mayPickPartner: false },
  ],
};

export interface CustomersSeed {
  counts: { customers: number; people: number };
  /** The password every new person got; null when nobody was created. */
  password: string | null;
}

/**
 * Seeds the demo customers and their people into one workspace. Idempotent: a customer is found by
 * name and a person by email, and anything found is left as it is. New people share one password:
 * `options.password`, else a random one, returned for the caller to print once.
 */
export async function seedCustomers(
  prisma: PrismaService,
  tenantId: string,
  options: { password?: string } = {},
): Promise<CustomersSeed> {
  const counts = { customers: 0, people: 0 };
  const password = options.password ?? randomBytes(16).toString('base64url');
  // Hashed once, before the transaction, which should not wait on argon2.
  const passwordHash = await hashPassword(password);

  await prisma.inTenant(tenantId, async (tx) => {
    const { defaultLocale } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });

    for (const seed of CUSTOMERS) {
      const group = seed.group ? await tx.customerGroup.findFirst({ where: { key: seed.group } }) : null;
      let customer = await tx.customer.findFirst({ where: { name: seed.name } });
      if (!customer) {
        customer = await tx.customer.create({
          data: {
            name: seed.name,
            customerGroupId: group?.id ?? null,
            shippingAddress: seed.shipping as Prisma.InputJsonValue,
            ...(seed.billing ? { billingAddress: seed.billing as Prisma.InputJsonValue } : {}),
            vatNumber: seed.vatNumber,
          },
        });
        counts.customers++;
      }

      for (const person of seed.people) {
        let user = await tx.user.findFirst({ where: { email: person.email } });
        if (!user) {
          user = await tx.user.create({
            data: { email: person.email, name: person.name, passwordHash, locale: defaultLocale, kind: 'customer' },
          });
          counts.people++;
        }
        const membership = { userId: user.id, organisationType: 'customer', organisationId: customer.id };
        if (!(await tx.organisationMembership.findFirst({ where: membership }))) {
          await tx.organisationMembership.create({ data: { ...membership, role: person.role } });
        }
      }
    }

    if (!(await tx.tenantSetting.findFirst({ where: { key: 'customers.priority' } }))) {
      await new SettingsService().set(tx, 'customers.priority', PRIORITY);
    }
  });

  return { counts, password: counts.people > 0 ? password : null };
}
