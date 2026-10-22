import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { decodeCursor } from '../../common/pagination/cursor';
import { toPage } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { Material } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import { resolveMaterialPrice } from './material-price';
import type { ResolvedPrice } from './material-price';
import type { MaterialResponse } from './material-response';
import { SnapshotsService } from './price-feed/snapshots.service';
import { UnitsService } from './units';
import type { UnitDef } from './units';

const decimal = (pattern: RegExp, message: string) => z.string().regex(pattern, message);
const priceSchema = decimal(/^\d{1,12}(\.\d{1,6})?$/, 'must be a decimal with at most 6 places, such as 0.85').refine(
  (value) => new Prisma.Decimal(value).greaterThan(0),
  'must be greater than 0',
);

const fieldsSchema = z.object({
  name: z.string().trim().min(1).max(200),
  priced_unit: z.string().min(1).max(32),
  density_g_cm3: priceSchema.nullable().optional(),
  price_source: z.enum(['feed', 'manual']),
  feed_metal: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,31}$/, 'a lowercase metal key, such as silver')
    .nullable()
    .optional(),
  addon_percent: decimal(/^-?\d{1,4}(\.\d{1,4})?$/, 'a percentage with at most 4 places, such as 8')
    .refine((value) => new Prisma.Decimal(value).greaterThan(-100), 'must be above -100')
    .optional(),
  addon_amount: decimal(/^\d{1,12}(\.\d{1,6})?$/, 'must be a decimal with at most 6 places').optional(),
  manual_price: priceSchema.nullable().optional(),
  fallback_price: priceSchema.nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'an ISO 4217 code, such as EUR').optional(),
});

/** A feed needs its metal and a fallback (B6); a manual material needs its price. */
function requireSourceFields(input: z.infer<typeof fieldsSchema>, ctx: z.RefinementCtx): void {
  const missing = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (input.price_source === 'feed') {
    if (!input.feed_metal) missing('feed_metal', 'Required when the price comes from the feed');
    if (!input.fallback_price) missing('fallback_price', 'Required when the price comes from the feed');
  } else if (!input.manual_price) {
    missing('manual_price', 'Required for a manual price');
  }
}

export const createMaterialSchema = fieldsSchema
  .extend({ key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'lowercase letters, digits and _, starting with a letter') })
  .superRefine(requireSourceFields);
export const updateMaterialSchema = fieldsSchema.partial();
const completeMaterialSchema = fieldsSchema.superRefine(requireSourceFields);

export const priceOverrideSchema = z.object({
  price: priceSchema,
  reason: z.string().trim().min(1).max(500).optional(),
});

const PRICED_DIMENSIONS = new Set(['mass', 'volume', 'count']);

@Injectable()
export class MaterialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly units: UnitsService,
    private readonly snapshots: SnapshotsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  async create(tenantId: string, input: z.infer<typeof createMaterialSchema>): Promise<MaterialResponse> {
    try {
      return await this.prisma.inTenant(tenantId, async (tx) => {
        const currency = input.currency ?? (await this.tenantCurrency(tx, tenantId));
        await this.checkPricedUnit(tx, input.priced_unit, input.price_source);
        const row = await tx.material.create({ data: { key: input.key, ...toColumns(input), currency } });
        return this.toResponse(tx, tenantId, row);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`A material with key ${input.key} already exists`);
      }
      throw error;
    }
  }

  async update(tenantId: string, id: string, patch: z.infer<typeof updateMaterialSchema>): Promise<MaterialResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const current = await this.find(tx, id);
      // The result must be a complete material, whatever the patch left out.
      const merged = completeMaterialSchema.parse({ ...toInput(current), ...patch });
      await this.checkPricedUnit(tx, merged.priced_unit, merged.price_source);
      const row = await tx.material.update({ where: { id }, data: { ...toColumns(merged), currency: merged.currency } });
      return this.toResponse(tx, tenantId, row);
    });
  }

  async get(tenantId: string, id: string): Promise<MaterialResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => this.toResponse(tx, tenantId, await this.find(tx, id)));
  }

  async list(tenantId: string, query: { limit: number; cursor?: string }): Promise<Page<MaterialResponse>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    return this.prisma.inTenant(tenantId, async (tx) => {
      const rows = await tx.material.findMany({
        where: after ? { id: { lt: after.id } } : {},
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      });
      const page = toPage(rows, query.limit, secret);
      const data: MaterialResponse[] = [];
      for (const row of page.data) {
        data.push(await this.toResponse(tx, tenantId, row));
      }
      return { data, next_cursor: page.next_cursor };
    });
  }

  /** Spec C5: the override wins until removed; both directions are audited (F8). */
  async setOverride(auth: TenantAuth, id: string, input: z.infer<typeof priceOverrideSchema>): Promise<MaterialResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const current = await this.find(tx, id);
      const row = await tx.material.update({
        where: { id },
        data: {
          overridePrice: input.price,
          overrideReason: input.reason ?? null,
          overrideAt: new Date(),
          overrideByUserId: auth.userId,
        },
      });
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'material.price_overridden',
        subject: { type: 'material', id },
        before: { override_price: current.overridePrice?.toFixed() ?? null },
        after: { override_price: input.price, reason: input.reason ?? null },
      });
      return this.toResponse(tx, auth.tenantId, row);
    });
  }

  /** Idempotent: removing an absent override changes and records nothing. */
  async removeOverride(auth: TenantAuth, id: string): Promise<void> {
    await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const current = await this.find(tx, id);
      if (!current.overridePrice) return;
      await tx.material.update({
        where: { id },
        data: { overridePrice: null, overrideReason: null, overrideAt: null, overrideByUserId: null },
      });
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'material.price_override_removed',
        subject: { type: 'material', id },
        before: { override_price: current.overridePrice.toFixed() },
        after: { override_price: null },
      });
    });
  }

  /** The material's current price in the workspace's currency, or why it has none. */
  async priceOf(
    tx: Prisma.TransactionClient,
    tenantId: string,
    material: Material,
  ): Promise<ResolvedPrice | { missing: string }> {
    const tenantCurrency = await this.tenantCurrency(tx, tenantId);
    const snapshot =
      material.priceSource === 'feed' && material.feedMetal
        ? await this.snapshots.latest(material.feedMetal, tenantCurrency)
        : null;
    return resolveMaterialPrice({
      material: {
        priceSource: material.priceSource as 'feed' | 'manual',
        currency: material.currency,
        manualPrice: material.manualPrice,
        fallbackPrice: material.fallbackPrice,
        overridePrice: material.overridePrice,
        overrideAt: material.overrideAt,
        addonPercent: material.addonPercent,
        addonAmount: material.addonAmount,
      },
      pricedUnit: await this.units.byKey(tx, material.pricedUnit),
      tenantCurrency,
      snapshot,
      now: new Date(),
      staleHours: this.config.get('METAL_PRICE_STALE_HOURS'),
    });
  }

  async find(tx: Prisma.TransactionClient, id: string): Promise<Material> {
    const row = await tx.material.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('Material not found');
    }
    return row;
  }

  private async tenantCurrency(tx: Prisma.TransactionClient, tenantId: string): Promise<string> {
    return (await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultCurrency: true } }))
      .defaultCurrency;
  }

  /** A price is per mass, volume or piece; the feed is per gram, so a feed material is priced by mass. */
  private async checkPricedUnit(tx: Prisma.TransactionClient, key: string, source: 'feed' | 'manual'): Promise<UnitDef> {
    let unit: UnitDef;
    try {
      unit = await this.units.byKey(tx, key);
    } catch (error) {
      if (error instanceof NotFoundException) throw new BadRequestException(`Unknown priced unit ${key}`);
      throw error;
    }
    if (!PRICED_DIMENSIONS.has(unit.dimension)) {
      throw new BadRequestException(`A material is priced by mass, volume or count, not ${unit.dimension}`);
    }
    if (source === 'feed' && unit.dimension !== 'mass') {
      throw new BadRequestException('A feed price is per gram, so the priced unit must be a mass');
    }
    return unit;
  }

  private async toResponse(tx: Prisma.TransactionClient, tenantId: string, row: Material): Promise<MaterialResponse> {
    const price = await this.priceOf(tx, tenantId, row);
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      priced_unit: row.pricedUnit,
      density_g_cm3: row.densityGCm3?.toFixed() ?? null,
      price_source: row.priceSource as 'feed' | 'manual',
      feed_metal: row.feedMetal,
      addon_percent: row.addonPercent.toFixed(),
      addon_amount: row.addonAmount.toFixed(),
      manual_price: row.manualPrice?.toFixed() ?? null,
      fallback_price: row.fallbackPrice?.toFixed() ?? null,
      currency: row.currency,
      override:
        row.overridePrice && row.overrideAt
          ? {
              price: row.overridePrice.toFixed(),
              reason: row.overrideReason,
              at: row.overrideAt.toISOString(),
              by_user_id: row.overrideByUserId,
            }
          : null,
      current_price:
        'missing' in price
          ? null
          : {
              unit_price: price.unitPrice.toFixed(),
              currency: price.currency,
              per_unit: price.perUnit,
              source: price.source,
              as_of: price.asOf?.toISOString() ?? null,
              stale: price.stale,
            },
      price_missing: 'missing' in price ? price.missing : null,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }
}

function toColumns(input: z.infer<typeof fieldsSchema>) {
  return {
    name: input.name,
    pricedUnit: input.priced_unit,
    densityGCm3: input.density_g_cm3 ?? null,
    priceSource: input.price_source,
    feedMetal: input.feed_metal ?? null,
    addonPercent: input.addon_percent ?? '0',
    addonAmount: input.addon_amount ?? '0',
    manualPrice: input.manual_price ?? null,
    fallbackPrice: input.fallback_price ?? null,
  };
}

function toInput(row: Material): z.input<typeof fieldsSchema> {
  return {
    name: row.name,
    priced_unit: row.pricedUnit,
    density_g_cm3: row.densityGCm3?.toFixed() ?? null,
    price_source: row.priceSource as 'feed' | 'manual',
    feed_metal: row.feedMetal,
    addon_percent: row.addonPercent.toFixed(),
    addon_amount: row.addonAmount.toFixed(),
    manual_price: row.manualPrice?.toFixed() ?? null,
    fallback_price: row.fallbackPrice?.toFixed() ?? null,
    currency: row.currency,
  };
}
