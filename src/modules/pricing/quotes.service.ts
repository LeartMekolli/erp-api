import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { decodeCursor } from '../../common/pagination/cursor';
import { toPage } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { Material, Quote, StepPrice } from '../../generated/prisma/client';
import { CheckService, checkRequestSchema } from '../catalog/check.service';
import type { Evaluation } from '../catalog/check.service';
import type { ResolvedPrice } from '../catalog/material-price';
import { MaterialsService } from '../catalog/materials.service';
import { UnitsService } from '../catalog/units';
import type { UnitDef } from '../catalog/units';
import type { TenantAuth } from '../identity/auth-context';
import { AdjustmentsService } from './adjustments.service';
import type { Block } from './blocks';
import { resolveChain } from './chain';
import type { ChainStep } from './chain';
import { ChainsService } from './chains.service';
import { keySchema } from './decimals';
import { priceConfiguration, tierFor } from './engine';
import type { Breakdown } from './engine';
import type {
  BreakdownJson,
  QuoteInputs,
  QuoteMaterial,
  QuoteRefusal,
  QuoteResponse,
  QuoteResultResponse,
  QuoteSummaryResponse,
} from './quote-response';
import type { PricedMaterial } from './step-cost';
import { PricingProfileService } from './step-types.service';
import { customerSummary } from './summary';

export const quoteRequestSchema = checkRequestSchema.extend({
  product_id: z.uuid(),
  /** Pieces, a whole number from 1 to 1,000,000. */
  quantity: z.number().int().min(1).max(1_000_000),
  /** A customer group key of the workspace; omitted: no group. */
  customer_group: keySchema.optional(),
  /** A delivery speed key of the workspace; omitted: the default speed, if there is one. */
  delivery_speed: keySchema.optional(),
});
export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

const DAY_MS = 86_400_000;
const exact = (value: Prisma.Decimal) => value.toDecimalPlaces(10, Prisma.Decimal.ROUND_HALF_UP).toFixed();

function breakdownJson(breakdown: Breakdown, evaluation: Extract<Evaluation, { accepted: true }>): BreakdownJson {
  return {
    scale: evaluation.scale.toFixed(),
    measures: evaluation.measures.map((measure) => ({ type: measure.type, value: measure.value.toFixed(6), unit: measure.unit })),
    steps: breakdown.steps.map((step) => ({
      key: step.key,
      name: step.name,
      summary_group: step.summaryGroup,
      blocks: step.cost.blocks.map((block) => ({ ...block, amount: exact(block.amount) })),
      subtotal: exact(step.cost.subtotal),
      failure: exact(step.cost.failure),
      cost: exact(step.cost.cost),
    })),
    cost_per_piece: exact(breakdown.costPerPiece),
    overhead: exact(breakdown.overhead),
    min_size_surcharge: exact(breakdown.minSizeSurcharge),
    margin: { percent: breakdown.margin.percent.toFixed(), amount: exact(breakdown.margin.amount) },
    price_before_adjustments: exact(breakdown.priceBeforeAdjustments),
    adjustments: breakdown.adjustments.map((line) => ({ kind: line.kind, percent: line.percent.toFixed(), amount: exact(line.amount) })),
    unit_price_exact: exact(breakdown.unitPriceExact),
    unit_price: breakdown.unitPrice.toFixed(2),
    total: breakdown.total.toFixed(2),
  };
}

function quoteMaterial(material: Material, price: ResolvedPrice): QuoteMaterial {
  return {
    id: material.id,
    key: material.key,
    unit_price: price.unitPrice.toFixed(),
    per_unit: price.perUnit,
    source: price.source,
    as_of: price.asOf?.toISOString() ?? null,
    stale: price.stale,
  };
}

/** Every material a step price names on its blocks. */
function namedMaterials(blocks: Block[]): string[] {
  const ids: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'material' && 'material_id' in block.source) ids.push(block.source.material_id);
    if (block.kind === 'batch' && block.material && 'material_id' in block.material.source) {
      ids.push(block.material.source.material_id);
    }
  }
  return ids;
}

/** Prices a configuration and saves it as a quote that holds until it expires (Pricing spec). */
@Injectable()
export class QuotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly check: CheckService,
    private readonly chains: ChainsService,
    private readonly adjustments: AdjustmentsService,
    private readonly profile: PricingProfileService,
    private readonly materials: MaterialsService,
    private readonly units: UnitsService,
  ) {}

  /** A saved quote's customer view, or why it cannot be quoted (nothing is saved then). */
  async create(auth: TenantAuth, body: QuoteRequest): Promise<QuoteResultResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      // Row-level security hides other tenants' products, so a foreign id is simply not found.
      const product = await tx.product.findUnique({ where: { id: body.product_id }, select: { id: true, name: true, categoryId: true } });
      if (!product) {
        throw new NotFoundException('Product not found');
      }
      const adjustments = await this.adjustments.load(tx, { categoryId: product.categoryId, productId: product.id });
      const groupKey = body.customer_group ?? null;
      if (groupKey && !adjustments.groups.has(groupKey)) {
        throw new BadRequestException(`customer_group: ${groupKey} is not a customer group of this workspace`);
      }
      const speedKey = body.delivery_speed ?? adjustments.defaultSpeedKey;
      if (speedKey && !adjustments.speeds.has(speedKey)) {
        throw new BadRequestException(`delivery_speed: ${speedKey} is not a delivery speed of this workspace`);
      }

      // 1. The Catalog check.
      const evaluation = await this.check.evaluate(tx, auth.tenantId, product.id, body);
      if (!evaluation.accepted) {
        return { accepted: false, reasons: evaluation.reasons };
      }

      // 2. The step chain.
      const chain = resolveChain({ ...(await this.chains.load(tx, product.id)), chosenValueIds: evaluation.valueIds });
      if ('conflict' in chain) {
        const { step, adding, removing } = chain.conflict;
        return {
          accepted: false,
          reasons: [{ code: 'step_conflict', step, message: `${adding} adds step ${step}, which ${removing} removes` }],
        };
      }

      // 3. Each step's price (the material's own, else the step's default) and every material it names.
      const prices = await this.stepPrices(tx, chain.steps, evaluation.material.id);
      const units = await this.units.all(tx);
      const priced = await this.pricedMaterials(tx, auth.tenantId, evaluation, prices, units);
      if ('reasons' in priced) {
        return { accepted: false, reasons: priced.reasons };
      }

      // 4–7. The engine, then the customer's view of it.
      const profile = await this.profile.get(tx);
      const result = priceConfiguration({
        quantity: body.quantity,
        steps: chain.steps.map((step) => {
          const price = prices.get(step.id);
          return { step, price: price ? { failurePercent: price.failurePercent, blocks: price.blocks as Block[] } : null };
        }),
        measures: evaluation.measures,
        units,
        materials: priced.materials,
        overheadPerPiece: profile.overheadPerPiece,
        minSize: adjustments.minSize,
        marginPercent: adjustments.marginPercent,
        tier: tierFor(adjustments.tiers, body.quantity),
        groupPercent: groupKey ? adjustments.groups.get(groupKey)! : null,
        speedPercent: speedKey ? adjustments.speeds.get(speedKey)! : null,
      });
      if (!result.accepted) {
        return { accepted: false, reasons: result.reasons };
      }
      const summary = customerSummary(result.breakdown);

      const inputs: QuoteInputs = {
        options: Object.fromEntries(evaluation.values.map((chosen) => [chosen.group, chosen.value])),
        size: body.size ?? null,
        file_version_id: body.file_version_id ?? null,
        customer_group: groupKey,
        delivery_speed: speedKey,
      };
      const row = await tx.quote.create({
        data: {
          productId: product.id,
          quantity: body.quantity,
          currency: evaluation.price.currency,
          unitPrice: result.breakdown.unitPrice,
          total: result.breakdown.total,
          inputs,
          materials: priced.list,
          breakdown: breakdownJson(result.breakdown, evaluation),
          summary: { lines: summary.lines.map((line) => ({ label: line.label, amount: line.amount.toFixed(2) })) },
          expiresAt: new Date(Date.now() + profile.quoteValidDays * DAY_MS),
          createdByUserId: auth.userId,
        },
      });
      return { accepted: true, quote: toSummary(row, product.name) };
    });
  }

  async get(tenantId: string, id: string): Promise<QuoteResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => toStaffView(await this.find(tx, id)));
  }

  async summary(tenantId: string, id: string): Promise<QuoteSummaryResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const row = await this.find(tx, id);
      const product = await tx.product.findUniqueOrThrow({ where: { id: row.productId }, select: { name: true } });
      return toSummary(row, product.name);
    });
  }

  async list(tenantId: string, query: { limit: number; cursor?: string }): Promise<Page<QuoteResponse>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    return this.prisma.inTenant(tenantId, async (tx) => {
      const rows = await tx.quote.findMany({
        where: after ? { id: { lt: after.id } } : {},
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      });
      const page = toPage(rows, query.limit, secret);
      return { data: page.data.map(toStaffView), next_cursor: page.next_cursor };
    });
  }

  /** The most specific price of each chain step: for the configuration's material, else the step's default (Q2). */
  private async stepPrices(tx: Prisma.TransactionClient, steps: ChainStep[], materialId: string): Promise<Map<string, StepPrice>> {
    const rows = await tx.stepPrice.findMany({
      where: { stepTypeId: { in: steps.map((step) => step.id) }, OR: [{ materialId: null }, { materialId }] },
    });
    const prices = new Map<string, StepPrice>();
    for (const step of steps) {
      const price =
        rows.find((row) => row.stepTypeId === step.id && row.materialId === materialId) ??
        rows.find((row) => row.stepTypeId === step.id && row.materialId === null);
      if (price) prices.set(step.id, price);
    }
    return prices;
  }

  /**
   * The configuration's material under `'configuration'`, and every material the steps name, each
   * with its current price; a named material without a usable price refuses the steps that use it.
   */
  private async pricedMaterials(
    tx: Prisma.TransactionClient,
    tenantId: string,
    evaluation: Extract<Evaluation, { accepted: true }>,
    prices: Map<string, StepPrice>,
    units: UnitDef[],
  ): Promise<{ materials: Map<string, PricedMaterial>; list: QuoteMaterial[] } | { reasons: QuoteRefusal[] }> {
    const unit = (key: string) => units.find((candidate) => candidate.key === key)!;
    const toPriced = (material: Material, price: ResolvedPrice): PricedMaterial => ({
      id: material.id,
      key: material.key,
      densityGCm3: material.densityGCm3,
      pricedUnit: unit(material.pricedUnit),
      price,
    });

    const materials = new Map<string, PricedMaterial>([['configuration', toPriced(evaluation.material, evaluation.price)]]);
    const list = new Map<string, QuoteMaterial>([[evaluation.material.id, quoteMaterial(evaluation.material, evaluation.price)]]);
    const reasons: QuoteRefusal[] = [];
    const stepKeys = await this.stepKeys(tx, [...prices.keys()]);

    for (const [stepTypeId, price] of prices) {
      for (const id of namedMaterials(price.blocks as Block[])) {
        if (materials.has(id)) continue;
        const material = await tx.material.findUnique({ where: { id } });
        const resolved = material ? await this.materials.priceOf(tx, tenantId, material) : { missing: 'it no longer exists' };
        if (!material || 'missing' in resolved) {
          const name = material?.key ?? id;
          const why = 'missing' in resolved ? resolved.missing : '';
          reasons.push({ code: 'price_missing', step: stepKeys.get(stepTypeId)!, message: `Material ${name}: ${why}` });
          continue;
        }
        materials.set(id, toPriced(material, resolved));
        list.set(id, quoteMaterial(material, resolved));
      }
    }
    if (reasons.length > 0) {
      return { reasons };
    }
    return { materials, list: [...list.values()] };
  }

  private async stepKeys(tx: Prisma.TransactionClient, ids: string[]): Promise<Map<string, string>> {
    const rows = await tx.stepType.findMany({ where: { id: { in: ids } }, select: { id: true, key: true } });
    return new Map(rows.map((row) => [row.id, row.key]));
  }

  private async find(tx: Prisma.TransactionClient, id: string): Promise<Quote> {
    const row = await tx.quote.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('Quote not found');
    }
    return row;
  }
}

const isExpired = (row: Quote) => Date.now() >= row.expiresAt.getTime();

function toSummary(row: Quote, productName: string): QuoteSummaryResponse {
  return {
    id: row.id,
    product: { id: row.productId, name: productName },
    quantity: row.quantity,
    currency: row.currency,
    lines: (row.summary as { lines: QuoteSummaryResponse['lines'] }).lines,
    unit_price: row.unitPrice.toFixed(2),
    total: row.total.toFixed(2),
    expires_at: row.expiresAt.toISOString(),
    expired: isExpired(row),
  };
}

function toStaffView(row: Quote): QuoteResponse {
  return {
    id: row.id,
    product_id: row.productId,
    quantity: row.quantity,
    currency: row.currency,
    unit_price: row.unitPrice.toFixed(2),
    total: row.total.toFixed(2),
    expires_at: row.expiresAt.toISOString(),
    expired: isExpired(row),
    created_at: row.createdAt.toISOString(),
    inputs: row.inputs as QuoteInputs,
    materials: row.materials as QuoteMaterial[],
    breakdown: row.breakdown as BreakdownJson,
  };
}
