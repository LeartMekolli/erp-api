import { randomBytes } from 'node:crypto';
import type { PrismaService } from '../database/prisma.service';
import { hashPassword } from '../modules/identity/passwords';

// Demo customers for the demo workspace, on top of its catalog and pricing (`seed-catalog.ts`,
// `seed-pricing.ts`): Luna Jewels gets the trade group, Mira Studio none.

const CUSTOMERS: { name: string; group: string | null; people: { email: string; name: string; role: string }[] }[] = [
  {
    name: 'Luna Jewels',
    group: 'trade',
    people: [
      { email: 'anna@luna.example.test', name: 'Anna', role: 'owner' },
      { email: 'ben@luna.example.test', name: 'Ben', role: 'buyer' },
    ],
  },
  {
    name: 'Mira Studio',
    group: null,
    people: [{ email: 'mira@mira.example.test', name: 'Mira', role: 'owner' }],
  },
];

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
        customer = await tx.customer.create({ data: { name: seed.name, customerGroupId: group?.id ?? null } });
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
  });

  return { counts, password: counts.people > 0 ? password : null };
}
