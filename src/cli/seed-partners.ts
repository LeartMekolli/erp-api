import { randomBytes } from 'node:crypto';
import type { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import { hashPassword } from '../modules/identity/passwords';

// Demo partners for the demo workspace, on top of its catalog, pricing and workflows (`seed-catalog.ts`,
// `seed-pricing.ts`, `seed-workflows.ts`): a foundry for cast metal parts and a print shop for printed
// parts, both approved, with the workspace's prices and an owner each.

interface PartnerSeed {
  name: string;
  owner: { email: string; name: string };
  acceptsDirectOrders: boolean;
  /** Step type keys, each with its capacity per week and the largest piece, in mm. */
  capabilities: { step: string; perWeek: number; maxSizeMm?: string }[];
  /** Option values it works with, by group key and value key. */
  offerings: Record<string, string[]>;
}

const PARTNERS: PartnerSeed[] = [
  {
    name: 'Northcast Foundry',
    owner: { email: 'owner@northcast.example.test', name: 'Nora' },
    acceptsDirectOrders: true,
    capabilities: [
      { step: 'print_pattern', perWeek: 300 },
      { step: 'casting_tree', perWeek: 300 },
      { step: 'casting', perWeek: 200, maxSizeMm: '80' },
      { step: 'polishing', perWeek: 200 },
      { step: 'plating', perWeek: 100 },
      { step: 'final_qc', perWeek: 300 },
      { step: 'packing', perWeek: 300 },
    ],
    offerings: { material: ['silver_925', 'gold_18k', 'brass'], finish: ['raw', 'polished', 'gold_plated'] },
  },
  {
    name: 'Layerline Prints',
    owner: { email: 'owner@layerline.example.test', name: 'Leo' },
    acceptsDirectOrders: false,
    capabilities: [
      { step: 'print', perWeek: 500, maxSizeMm: '250' },
      { step: 'cure', perWeek: 500 },
      { step: 'finish', perWeek: 300 },
      { step: 'final_qc', perWeek: 500 },
      { step: 'packing', perWeek: 500 },
    ],
    offerings: { material: ['resin_standard', 'nylon_pa12', 'pla'], finish: ['raw', 'polished'] },
  },
];

export interface PartnersSeed {
  counts: { partners: number; people: number };
  /** The password every new owner got; null when nobody was created. */
  password: string | null;
}

/**
 * Seeds the demo partners into one workspace. Idempotent: a partner is found by name and a person by
 * email, and anything found is left as it is. A new partner gets its capabilities, offerings, the
 * workspace's prices for the priced steps it does, and an agreement on file: a placeholder document
 * record, with nothing uploaded. New owners share one password: `options.password`, else a random one,
 * returned for the caller to print once.
 */
export async function seedPartners(
  prisma: PrismaService,
  tenantId: string,
  options: { password?: string } = {},
): Promise<PartnersSeed> {
  const counts = { partners: 0, people: 0 };
  const password = options.password ?? randomBytes(16).toString('base64url');
  // Hashed once, before the transaction, which should not wait on argon2.
  const passwordHash = await hashPassword(password);

  await prisma.inTenant(tenantId, async (tx) => {
    const { defaultLocale } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const stepTypes = new Map((await tx.stepType.findMany({ select: { id: true, key: true } })).map((type) => [type.key, type.id]));

    for (const seed of PARTNERS) {
      let user = await tx.user.findFirst({ where: { email: seed.owner.email } });
      if (!user) {
        user = await tx.user.create({
          data: { email: seed.owner.email, name: seed.owner.name, passwordHash, locale: defaultLocale, kind: 'partner' },
        });
        counts.people++;
      }

      let partner = await tx.partner.findFirst({ where: { name: seed.name } });
      if (!partner) {
        partner = await tx.partner.create({
          data: { name: seed.name, displayName: seed.name, status: 'approved', acceptsDirectOrders: seed.acceptsDirectOrders },
        });
        counts.partners++;
        await setUp(tx, partner.id, user.id, seed, stepTypes);
      }

      const membership = { userId: user.id, organisationType: 'partner', organisationId: partner.id };
      if (!(await tx.organisationMembership.findFirst({ where: membership }))) {
        await tx.organisationMembership.create({ data: { ...membership, role: 'owner' } });
      }
    }
  });

  return { counts, password: counts.people > 0 ? password : null };
}

/** A new partner's capabilities, offerings, prices and agreement. */
async function setUp(
  tx: Prisma.TransactionClient,
  partnerId: string,
  ownerId: string,
  seed: PartnerSeed,
  stepTypes: Map<string, string>,
): Promise<void> {
  // A step type this workspace doesn't have is left out.
  const capabilities = seed.capabilities.filter((capability) => stepTypes.has(capability.step));
  await tx.partnerCapability.createMany({
    data: capabilities.map((capability) => ({
      partnerId,
      stepTypeId: stepTypes.get(capability.step)!,
      capacity: capability.perWeek,
      capacityPeriod: 'week',
      maxSizeMm: capability.maxSizeMm ?? null,
    })),
  });

  const values = await tx.optionValue.findMany({
    where: { OR: Object.entries(seed.offerings).map(([group, keys]) => ({ group: { key: group }, key: { in: keys } })) },
    select: { id: true },
  });
  await tx.partnerOffering.createMany({ data: values.map((value) => ({ partnerId, optionValueId: value.id })) });

  const prices = await tx.stepPrice.findMany({
    where: { stepTypeId: { in: capabilities.map((capability) => stepTypes.get(capability.step)!) } },
  });
  await tx.partnerStepPrice.createMany({
    data: prices.map((price) => ({
      partnerId,
      stepTypeId: price.stepTypeId,
      materialId: price.materialId,
      failurePercent: price.failurePercent,
      blocks: price.blocks as Prisma.InputJsonValue,
    })),
  });

  const file = await tx.file.create({
    data: { kind: 'document', name: 'Partner agreement.pdf', ownerType: 'partner', ownerId: partnerId, createdByUserId: ownerId },
  });
  const version = await tx.fileVersion.create({
    data: {
      fileId: file.id,
      number: 1,
      storageKey: `seed/partners/${partnerId}/agreement.pdf`,
      originalName: 'Partner agreement.pdf',
      contentType: 'application/pdf',
      size: 0,
      status: 'uploaded',
      uploadedByUserId: ownerId,
      completedAt: new Date(),
    },
  });
  await tx.partner.update({
    where: { id: partnerId },
    data: { agreementFileVersionId: version.id, agreementSignedOn: new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) },
  });
}
