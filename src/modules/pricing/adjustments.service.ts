import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import type {
  CustomerGroup,
  DeliverySpeed,
  DiscountTier,
  MarginOverride,
  MinSizeSurcharge,
  Prisma,
} from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { SEEDED_UNITS, UnitsService, convert } from '../catalog/units';
import type { Dimension, UnitDef } from '../catalog/units';
import { MEASURE_TYPES } from '../files/measurers';
import type { MeasureType } from '../files/measurers';
import type { TenantAuth } from '../identity/auth-context';
import { MEASURE_DIMENSION } from './blocks';
import { amountSchema, conflictOnDuplicate, keySchema, percentSchema, positiveAmountSchema } from './decimals';
import type {
  CustomerGroupResponse,
  DeliverySpeedResponse,
  DiscountTiersResponse,
  MarginOverrideResponse,
  MinSizeSurchargeResponse,
} from './pricing-response';
import { PricingProfileService } from './step-types.service';

const nameSchema = z.string().trim().min(1).max(200);

export const marginSchema = z.object({ margin_percent: percentSchema(0, 1000) });

export const discountTiersSchema = z.object({
  tiers: z
    .array(z.object({ min_quantity: z.number().int().min(2).max(1_000_000), percent: percentSchema(0, 100) }))
    .max(20)
    .refine((tiers) => new Set(tiers.map((tier) => tier.min_quantity)).size === tiers.length, 'quantities must not repeat'),
});

export const createCustomerGroupSchema = z.object({ key: keySchema, name: nameSchema, percent: percentSchema(-50, 100) });
export const updateCustomerGroupSchema = z.object({ name: nameSchema.optional(), percent: percentSchema(-50, 100).optional() });

export const createDeliverySpeedSchema = z.object({
  key: keySchema,
  name: nameSchema,
  surcharge_percent: percentSchema(0, 500),
  is_default: z.boolean().default(false),
});
export const updateDeliverySpeedSchema = z.object({
  name: nameSchema.optional(),
  surcharge_percent: percentSchema(0, 500).optional(),
  is_default: z.boolean().optional(),
});

export const createMinSizeSurchargeSchema = z.object({
  /** Omitted: applies to every category. */
  category_id: z.uuid().optional(),
  measure: z.enum(MEASURE_TYPES),
  below: positiveAmountSchema,
  unit: z.string().min(1).max(32),
  amount: amountSchema,
});

/** The base unit of each dimension, which design measures are given in. */
const BASE_UNIT: Record<Dimension, UnitDef> = Object.fromEntries(
  (['mm', 'mm2', 'mm3', 'g', 'piece'] as const).map((key) => {
    const unit = SEEDED_UNITS.find((candidate) => candidate.key === key)!;
    return [unit.dimension, unit];
  }),
) as Record<Dimension, UnitDef>;

/** What the engine needs beyond step costs, for one product (Pricing spec). */
export interface Adjustments {
  /** The product's override, else its category's, else the pricing profile's (Q5). */
  marginPercent: Prisma.Decimal;
  /** By quantity, lowest first. */
  tiers: { minQuantity: number; percent: Prisma.Decimal }[];
  /** Customer group key → percent. */
  groups: Map<string, Prisma.Decimal>;
  /** Delivery speed key → surcharge percent. */
  speeds: Map<string, Prisma.Decimal>;
  defaultSpeedKey: string | null;
  /** The category's and the workspace-wide ones; `below` in the measure's base unit (mm, mm2, mm3, piece). */
  minSize: { measure: MeasureType; below: Prisma.Decimal; amount: Prisma.Decimal }[];
}

const toMargin = (row: MarginOverride): MarginOverrideResponse => ({
  category_id: row.categoryId,
  product_id: row.productId,
  margin_percent: row.marginPercent.toFixed(),
});
const toTiers = (rows: DiscountTier[]): DiscountTiersResponse => ({
  data: rows.map((row) => ({ min_quantity: row.minQuantity, percent: row.percent.toFixed() })),
});
const toGroup = (row: CustomerGroup): CustomerGroupResponse => ({
  id: row.id,
  key: row.key,
  name: row.name,
  percent: row.percent.toFixed(),
});
const toSpeed = (row: DeliverySpeed): DeliverySpeedResponse => ({
  id: row.id,
  key: row.key,
  name: row.name,
  surcharge_percent: row.surchargePercent.toFixed(),
  is_default: row.isDefault,
});
const toSurcharge = (row: MinSizeSurcharge): MinSizeSurchargeResponse => ({
  id: row.id,
  category_id: row.categoryId,
  measure: row.measure as MeasureType,
  below: row.below.toFixed(),
  unit: row.unit,
  amount: row.amount.toFixed(),
});

type MarginTarget = 'category' | 'product';

/** Margins, quantity discount tiers, customer groups, delivery speeds and minimum-size surcharges. */
@Injectable()
export class AdjustmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly units: UnitsService,
    private readonly profile: PricingProfileService,
    private readonly audit: AuditService,
  ) {}

  async setMargin(
    auth: TenantAuth,
    target: MarginTarget,
    id: string,
    input: z.infer<typeof marginSchema>,
  ): Promise<MarginOverrideResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await this.findTarget(tx, target, id);
      const where = target === 'category' ? { categoryId: id } : { productId: id };
      const before = await tx.marginOverride.findUnique({ where });
      const row = await tx.marginOverride.upsert({
        where,
        create: { ...where, marginPercent: input.margin_percent },
        update: { marginPercent: input.margin_percent },
      });
      const saved = toMargin(row);
      await this.record(tx, auth, { type: 'margin_override', id: row.id }, before ? toMargin(before) : undefined, saved);
      return saved;
    });
  }

  async clearMargin(auth: TenantAuth, target: MarginTarget, id: string): Promise<void> {
    await this.prisma.inTenant(auth.tenantId, async (tx) => {
      await this.findTarget(tx, target, id);
      const row = await tx.marginOverride.findUnique({ where: target === 'category' ? { categoryId: id } : { productId: id } });
      if (row) {
        await tx.marginOverride.delete({ where: { id: row.id } });
        await this.record(tx, auth, { type: 'margin_override', id: row.id }, toMargin(row), undefined);
      }
    });
  }

  async tiers(tenantId: string): Promise<DiscountTiersResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => toTiers(await this.allTiers(tx)));
  }

  async setTiers(auth: TenantAuth, input: z.infer<typeof discountTiersSchema>): Promise<DiscountTiersResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      // Two replacements at once would both delete, then collide on insert; the second waits here instead.
      await this.lock(tx, auth.tenantId, 'discount_tiers');
      const before = toTiers(await this.allTiers(tx));
      await tx.discountTier.deleteMany({});
      await tx.discountTier.createMany({
        data: input.tiers.map((tier) => ({ minQuantity: tier.min_quantity, percent: tier.percent })),
      });
      const after = toTiers(await this.allTiers(tx));
      await this.record(tx, auth, { type: 'discount_tiers' }, before, after);
      return after;
    });
  }

  async groups(tenantId: string): Promise<CustomerGroupResponse[]> {
    return this.prisma.inTenant(tenantId, async (tx) => (await tx.customerGroup.findMany({ orderBy: { key: 'asc' } })).map(toGroup));
  }

  async createGroup(auth: TenantAuth, input: z.infer<typeof createCustomerGroupSchema>): Promise<CustomerGroupResponse> {
    try {
      return await this.prisma.inTenant(auth.tenantId, async (tx) => {
        const created = toGroup(await tx.customerGroup.create({ data: input }));
        await this.record(tx, auth, { type: 'customer_group', id: created.id }, undefined, created);
        return created;
      });
    } catch (error) {
      conflictOnDuplicate(error, `A customer group with key ${input.key} already exists`);
    }
  }

  async updateGroup(auth: TenantAuth, id: string, patch: z.infer<typeof updateCustomerGroupSchema>): Promise<CustomerGroupResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const current = await tx.customerGroup.findUnique({ where: { id } });
      if (!current) {
        throw new NotFoundException('Customer group not found');
      }
      const updated = toGroup(await tx.customerGroup.update({ where: { id }, data: patch }));
      await this.record(tx, auth, { type: 'customer_group', id }, toGroup(current), updated);
      return updated;
    });
  }

  async speeds(tenantId: string): Promise<DeliverySpeedResponse[]> {
    return this.prisma.inTenant(tenantId, async (tx) => (await tx.deliverySpeed.findMany({ orderBy: { key: 'asc' } })).map(toSpeed));
  }

  async createSpeed(auth: TenantAuth, input: z.infer<typeof createDeliverySpeedSchema>): Promise<DeliverySpeedResponse> {
    try {
      return await this.prisma.inTenant(auth.tenantId, async (tx) => {
        await this.lock(tx, auth.tenantId, 'delivery_speed');
        if (input.is_default) await this.refuseSecondDefault(tx, null);
        const created = toSpeed(
          await tx.deliverySpeed.create({
            data: { key: input.key, name: input.name, surchargePercent: input.surcharge_percent, isDefault: input.is_default },
          }),
        );
        await this.record(tx, auth, { type: 'delivery_speed', id: created.id }, undefined, created);
        return created;
      });
    } catch (error) {
      conflictOnDuplicate(error, `A delivery speed with key ${input.key} already exists`);
    }
  }

  async updateSpeed(auth: TenantAuth, id: string, patch: z.infer<typeof updateDeliverySpeedSchema>): Promise<DeliverySpeedResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await this.lock(tx, auth.tenantId, 'delivery_speed');
      const current = await tx.deliverySpeed.findUnique({ where: { id } });
      if (!current) {
        throw new NotFoundException('Delivery speed not found');
      }
      if (patch.is_default) await this.refuseSecondDefault(tx, id);
      const updated = toSpeed(
        await tx.deliverySpeed.update({
          where: { id },
          data: { name: patch.name, surchargePercent: patch.surcharge_percent, isDefault: patch.is_default },
        }),
      );
      await this.record(tx, auth, { type: 'delivery_speed', id }, toSpeed(current), updated);
      return updated;
    });
  }

  async surcharges(tenantId: string): Promise<MinSizeSurchargeResponse[]> {
    return this.prisma.inTenant(tenantId, async (tx) =>
      (await tx.minSizeSurcharge.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(toSurcharge),
    );
  }

  async createSurcharge(auth: TenantAuth, input: z.infer<typeof createMinSizeSurchargeSchema>): Promise<MinSizeSurchargeResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      if (input.category_id) await this.findTarget(tx, 'category', input.category_id);
      const dimension = MEASURE_DIMENSION[input.measure];
      if (!dimension) {
        throw new BadRequestException(`${input.measure} cannot have a minimum size`);
      }
      const unit = (await this.units.all(tx)).find((candidate) => candidate.key === input.unit);
      if (!unit) {
        throw new BadRequestException(`Unknown unit ${input.unit}`);
      }
      if (unit.dimension !== dimension) {
        throw new BadRequestException(`${input.unit} is not a unit of ${input.measure} (${dimension})`);
      }
      const created = toSurcharge(
        await tx.minSizeSurcharge.create({
          data: {
            categoryId: input.category_id ?? null,
            measure: input.measure,
            below: input.below,
            unit: input.unit,
            amount: input.amount,
          },
        }),
      );
      await this.record(tx, auth, { type: 'min_size_surcharge', id: created.id }, undefined, created);
      return created;
    });
  }

  async removeSurcharge(auth: TenantAuth, id: string): Promise<void> {
    await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const row = await tx.minSizeSurcharge.findUnique({ where: { id } });
      if (!row) {
        throw new NotFoundException('Minimum-size surcharge not found');
      }
      await tx.minSizeSurcharge.delete({ where: { id } });
      await this.record(tx, auth, { type: 'min_size_surcharge', id }, toSurcharge(row), undefined);
    });
  }

  /** Everything the engine applies after step costs, for a product in a category. */
  async load(tx: Prisma.TransactionClient, target: { categoryId: string; productId: string }): Promise<Adjustments> {
    const [overrides, profile, tiers, groups, speeds, surcharges, units] = await Promise.all([
      tx.marginOverride.findMany({ where: { OR: [{ categoryId: target.categoryId }, { productId: target.productId }] } }),
      this.profile.get(tx),
      this.allTiers(tx),
      tx.customerGroup.findMany(),
      tx.deliverySpeed.findMany(),
      tx.minSizeSurcharge.findMany({ where: { OR: [{ categoryId: null }, { categoryId: target.categoryId }] } }),
      this.units.all(tx),
    ]);
    const margin =
      overrides.find((row) => row.productId === target.productId) ?? overrides.find((row) => row.categoryId === target.categoryId);
    return {
      marginPercent: margin ? margin.marginPercent : profile.marginPercent,
      tiers: tiers.map((row) => ({ minQuantity: row.minQuantity, percent: row.percent })),
      groups: new Map(groups.map((row) => [row.key, row.percent])),
      speeds: new Map(speeds.map((row) => [row.key, row.surchargePercent])),
      defaultSpeedKey: speeds.find((row) => row.isDefault)?.key ?? null,
      minSize: surcharges.map((row) => {
        const unit = units.find((candidate) => candidate.key === row.unit)!;
        return { measure: row.measure as MeasureType, below: convert(row.below, unit, BASE_UNIT[unit.dimension]), amount: row.amount };
      }),
    };
  }

  private allTiers(tx: Prisma.TransactionClient): Promise<DiscountTier[]> {
    return tx.discountTier.findMany({ orderBy: { minQuantity: 'asc' } });
  }

  private async refuseSecondDefault(tx: Prisma.TransactionClient, exceptId: string | null): Promise<void> {
    const other = await tx.deliverySpeed.findFirst({ where: { isDefault: true, ...(exceptId ? { id: { not: exceptId } } : {}) } });
    if (other) {
      throw new ConflictException(`${other.key} is already the default delivery speed`);
    }
  }

  /** Row-level security hides other workspaces' rows, so a foreign id is simply not found. */
  private async findTarget(tx: Prisma.TransactionClient, target: MarginTarget, id: string): Promise<void> {
    const found =
      target === 'category'
        ? await tx.category.findUnique({ where: { id }, select: { id: true } })
        : await tx.product.findUnique({ where: { id }, select: { id: true } });
    if (!found) {
      throw new NotFoundException(target === 'category' ? 'Category not found' : 'Product not found');
    }
  }

  /** Serialises a tenant's writes to one kind of list for the rest of the transaction. */
  private async lock(tx: Prisma.TransactionClient, tenantId: string, name: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${name}`}::text, 0))`;
  }

  private async record(
    tx: Prisma.TransactionClient,
    auth: TenantAuth,
    subject: { type: string; id?: string },
    before: object | undefined,
    after: object | undefined,
  ): Promise<void> {
    await this.audit.record(tx, {
      actor: { type: 'user', id: auth.userId },
      action: 'pricing.changed',
      subject,
      before: before as Prisma.InputJsonValue | undefined,
      after: after as Prisma.InputJsonValue | undefined,
    });
  }
}
