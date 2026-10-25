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
import { visibleTo } from '../catalog/visibility';
import type { TenantAuth } from '../identity/auth-context';
import { missingStepTypes, resolveWorkflow } from '../workflow/coverage';
import { partnerStepTypeIds } from '../workflow/partner-steps';
import { AdjustmentsService } from './adjustments.service';
import type { Adjustments } from './adjustments.service';
import type { Block } from './blocks';
import { resolveChain } from './chain';
import type { ChainStep } from './chain';
import { ChainsService } from './chains.service';
import { keySchema } from './decimals';
import { priceConfiguration, tierFor } from './engine';
import type { Breakdown } from './engine';
import { partnerCost, pricesFor } from './partner-cost';
import type { PriceSource } from './partner-cost';
import type {
  BreakdownJson,
  QuoteInputs,
  QuoteMaterial,
  QuotePrice,
  QuoteRefusal,
  QuoteResponse,
  QuoteResultResponse,
  QuoteSummaryResponse,
} from './quote-response';
import type { PricedMaterial } from './step-cost';
import { PricingProfileService } from './step-types.service';
import { customerSummary } from './summary';

const quoteFields = {
  ...checkRequestSchema.shape,
  product_id: z.uuid(),
  /** Pieces, a whole number from 1 to 1,000,000. */
  quantity: z.number().int().min(1).max(1_000_000),
  /** A delivery speed key of the workspace; omitted: the default speed, if there is one. */
  delivery_speed: keySchema.optional(),
};

export const quoteRequestSchema = z.object({
  ...quoteFields,
  /** A customer group key of the workspace; omitted: no group. Not with `customer_id`. */
  customer_group: keySchema.optional(),
  /** Quotes for that customer: its group applies and its people see the quote. */
  customer_id: z.uuid().optional(),
});
export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

/** What a customer may send: no customer group, which comes from the customer, and nothing unknown. */
export const customerQuoteRequestSchema = z.strictObject(quoteFields);
export type CustomerQuoteRequest = z.infer<typeof customerQuoteRequestSchema>;

/**
 * Who a quote is for. `customer` is the customer's own request: only products
 * it may see and files it owns can be quoted.
 */
export interface QuoteContext {
  customerId: string;
  audience: 'customer' | 'staff';
}

/** Whoever asks for the quote: a staff user or a customer person. */
type Requester = Pick<TenantAuth, 'tenantId' | 'userId'>;

/** What was priced, for a picked workshop to judge whether it can take the job (Partners spec, goal 12). */
export interface QuotedJob {
  productId: string;
  quantity: number;
  /** The step types the quote priced. */
  chainStepTypeIds: string[];
  optionValueIds: string[];
  /** At the chosen size, in base units (mm, mm², mm³). */
  measures: { type: string; value: Prisma.Decimal }[];
}

/**
 * A workshop the customer picked: its prices replace the workspace's on its steps, and the quote is
 * refused with `partner_unavailable` unless it `admits` the job, judged inside the quote's transaction.
 * Partners provides it, so Pricing never depends on Partners.
 */
export interface PartnerChoice {
  partnerId: string;
  admits(tx: Prisma.TransactionClient, job: QuotedJob): Promise<boolean>;
}

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

/** A step price of either list: the workspace's, or a partner's. */
type PriceRow = Pick<StepPrice, 'stepTypeId' | 'materialId' | 'failurePercent' | 'blocks'>;

/** The most specific price of each chain step: for the configuration's material, else the step's default (Q2). */
function mostSpecific(rows: PriceRow[], steps: ChainStep[], materialId: string): Map<string, PriceRow> {
  const prices = new Map<string, PriceRow>();
  for (const step of steps) {
    const price =
      rows.find((row) => row.stepTypeId === step.id && row.materialId === materialId) ??
      rows.find((row) => row.stepTypeId === step.id && row.materialId === null);
    if (price) prices.set(step.id, price);
  }
  return prices;
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

  /**
   * A saved quote's customer view, or why it cannot be quoted (nothing is saved then). With a
   * context, the quote is for that customer and gets the customer's own group; a customer's own
   * request may only name products it may see and files it owns, anything else is not found.
   */
  async create(
    auth: Requester,
    body: CustomerQuoteRequest & { customer_group?: string },
    context?: QuoteContext,
    partner?: PartnerChoice,
  ): Promise<QuoteResultResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const priced = await this.priceRequest(tx, auth.tenantId, body, context, partner);
      if (!priced.accepted) {
        return { accepted: false, reasons: priced.reasons };
      }
      const { product, groupKey, speedKey, result } = priced;
      const { evaluation, profile } = result;
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
          materials: result.materials,
          breakdown: breakdownJson(result.breakdown, evaluation),
          summary: { lines: summary.lines.map((line) => ({ label: line.label, amount: line.amount.toFixed(2) })) },
          expiresAt: new Date(Date.now() + profile.quoteValidDays * DAY_MS),
          createdByUserId: auth.userId,
          customerId: context?.customerId ?? null,
          partnerId: partner?.partnerId ?? null,
          partnerCost: partner ? partnerCost(result.breakdown.steps, result.partnerStepKeys, body.quantity) : null,
        },
      });
      return { accepted: true, quote: toSummary(row, product.name) };
    });
  }

  /** As `create`, with nothing saved: the price a customer would be quoted, such as with a workshop it may pick. */
  async preview(
    auth: Requester,
    body: CustomerQuoteRequest,
    context: QuoteContext,
    partner?: PartnerChoice,
  ): Promise<{ accepted: true; price: QuotePrice } | { accepted: false; reasons: QuoteRefusal[] }> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const priced = await this.priceRequest(tx, auth.tenantId, body, context, partner);
      if (!priced.accepted) {
        return { accepted: false, reasons: priced.reasons };
      }
      const { breakdown, evaluation } = priced.result;
      return {
        accepted: true,
        price: {
          currency: evaluation.price.currency,
          lines: customerSummary(breakdown).lines.map((line) => ({ label: line.label, amount: line.amount.toFixed(2) })),
          unit_price: breakdown.unitPrice.toFixed(2),
          total: breakdown.total.toFixed(2),
        },
      };
    });
  }

  /**
   * Everything a quote checks and prices, before anything is saved: the customer's own products and
   * files, the group and speed, the pricing run, and the picked workshop, which must take the job as
   * priced (else `partner_unavailable`).
   */
  private async priceRequest(
    tx: Prisma.TransactionClient,
    tenantId: string,
    body: CustomerQuoteRequest & { customer_group?: string },
    context: QuoteContext | undefined,
    partner: PartnerChoice | undefined,
  ) {
    if (context && body.customer_group) {
      throw new BadRequestException("customer_group: a customer's quote gets the customer's own group");
    }
    const customer = context ? await this.findCustomer(tx, context.customerId) : null;
    const onlyVisible = context?.audience === 'customer' ? visibleTo(context.customerId) : {};
    // Row-level security hides other tenants' products, so a foreign id is simply not found.
    const product = await tx.product.findFirst({
      where: { id: body.product_id, ...onlyVisible },
      select: { id: true, name: true, categoryId: true },
    });
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    if (context?.audience === 'customer' && body.file_version_id) {
      const owned = await tx.fileVersion.findFirst({
        where: { id: body.file_version_id, file: { ownerType: 'customer', ownerId: context.customerId } },
        select: { id: true },
      });
      if (!owned) {
        throw new NotFoundException('File version not found');
      }
    }
    const adjustments = await this.adjustments.load(tx, { categoryId: product.categoryId, productId: product.id });
    const groupKey = customer ? customer.groupKey : (body.customer_group ?? null);
    if (groupKey && !adjustments.groups.has(groupKey)) {
      throw new BadRequestException(`customer_group: ${groupKey} is not a customer group of this workspace`);
    }
    const speedKey = body.delivery_speed ?? adjustments.defaultSpeedKey;
    if (speedKey && !adjustments.speeds.has(speedKey)) {
      throw new BadRequestException(`delivery_speed: ${speedKey} is not a delivery speed of this workspace`);
    }

    const result = await this.run(tx, tenantId, product, body, { adjustments, groupKey, speedKey, partnerId: partner?.partnerId });
    if (!result.accepted) {
      return { accepted: false as const, reasons: result.reasons };
    }
    if (partner) {
      const job: QuotedJob = {
        productId: product.id,
        quantity: body.quantity,
        chainStepTypeIds: result.chainStepTypeIds,
        optionValueIds: result.evaluation.valueIds,
        measures: result.evaluation.measures,
      };
      if (!(await partner.admits(tx, job))) {
        return {
          accepted: false as const,
          reasons: [{ code: 'partner_unavailable' as const, message: 'The workshop picked cannot take this job right now' }],
        };
      }
    }
    return { accepted: true as const, product, groupKey, speedKey, result };
  }

  /** A customer's quotes as it sees them, newest first. */
  async customerList(
    tenantId: string,
    customerId: string,
    query: { limit: number; cursor?: string },
  ): Promise<Page<QuoteSummaryResponse>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    return this.prisma.inTenant(tenantId, async (tx) => {
      const rows = await tx.quote.findMany({
        where: { customerId, ...(after ? { id: { lt: after.id } } : {}) },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
        include: { product: { select: { name: true } } },
      });
      const page = toPage(rows, query.limit, secret);
      return { data: page.data.map((row) => toSummary(row, row.product.name)), next_cursor: page.next_cursor };
    });
  }

  /** One of the customer's quotes as it sees it; another customer's, or an internal one, is not found. */
  async customerSummary(tenantId: string, customerId: string, id: string): Promise<QuoteSummaryResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const row = await tx.quote.findFirst({ where: { id, customerId }, include: { product: { select: { name: true } } } });
      if (!row) {
        throw new NotFoundException('Quote not found');
      }
      return toSummary(row, row.product.name);
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

  /**
   * What a saved quote's job costs with a partner (Partners spec, goal 8 and B1): its inputs priced
   * again at today's prices, with the partner's prices on the partner's steps, summing only those
   * steps. A step the partner hasn't priced, or anything else that can't be priced, is a refusal.
   */
  async costFor(
    tx: Prisma.TransactionClient,
    quoteId: string,
    partnerId: string,
  ): Promise<{ cost: Prisma.Decimal; refusals: [] } | { cost: null; refusals: QuoteRefusal[] }> {
    const quote = await this.find(tx, quoteId);
    const product = await tx.product.findUniqueOrThrow({
      where: { id: quote.productId },
      select: { id: true, name: true, categoryId: true },
    });
    const inputs = quote.inputs as QuoteInputs;
    const adjustments = await this.adjustments.load(tx, { categoryId: product.categoryId, productId: product.id });
    const request = {
      options: inputs.options,
      size: inputs.size ?? undefined,
      file_version_id: inputs.file_version_id ?? undefined,
      quantity: quote.quantity,
    };
    const result = await this.run(tx, quote.tenantId, product, request, {
      adjustments,
      groupKey: inputs.customer_group,
      speedKey: inputs.delivery_speed,
      partnerId,
    });
    if (!result.accepted) {
      return { cost: null, refusals: result.reasons };
    }
    return { cost: partnerCost(result.breakdown.steps, result.partnerStepKeys, quote.quantity), refusals: [] };
  }

  /**
   * Prices a configuration (Pricing spec, "Order of calculation"): the Catalog check, the step chain,
   * the workflow's coverage of it, each step's price and the materials they name, then the engine.
   * With `partnerId`, the partner's prices replace the workspace's on the partner's steps.
   */
  private async run(
    tx: Prisma.TransactionClient,
    tenantId: string,
    product: { id: string; name: string },
    request: z.infer<typeof checkRequestSchema> & { quantity: number },
    pricing: { adjustments: Adjustments; groupKey: string | null; speedKey: string | null; partnerId?: string },
  ): Promise<
    | { accepted: false; reasons: QuoteRefusal[] }
    | {
        accepted: true;
        evaluation: Extract<Evaluation, { accepted: true }>;
        breakdown: Breakdown;
        materials: QuoteMaterial[];
        profile: Awaited<ReturnType<PricingProfileService['get']>>;
        /** The keys of the chain's steps that are the partner's; empty without a partner. */
        partnerStepKeys: Set<string>;
        chainStepTypeIds: string[];
      }
  > {
    // 1. The Catalog check.
    const evaluation = await this.check.evaluate(tx, tenantId, product.id, request);
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

    // 2b. Production must be able to do every step the quote prices (Workflow/QC spec F13).
    const workflow = await resolveWorkflow(tx, product.id);
    if (!workflow) {
      return { accepted: false, reasons: [{ code: 'workflow_missing', message: `Product ${product.name} has no workflow` }] };
    }
    const missing = new Set(missingStepTypes(workflow.steps, chain.steps.map((step) => step.id)));
    if (missing.size > 0) {
      return {
        accepted: false,
        reasons: chain.steps
          .filter((step) => missing.has(step.id))
          .map((step) => ({
            code: 'workflow_step_missing' as const,
            step: step.key,
            message: `Workflow ${workflow.name} has no ${step.key} step`,
          })),
      };
    }

    // 3. Each step's price (the material's own, else the step's default; the partner's on its steps)
    // and every material it names.
    const materialId = evaluation.material.id;
    const where = { stepTypeId: { in: chain.steps.map((step) => step.id) }, OR: [{ materialId: null }, { materialId }] };
    const partnerStepTypes = pricing.partnerId ? partnerStepTypeIds(workflow.steps) : new Set<string>();
    const source: PriceSource<PriceRow> = {
      workspace: mostSpecific(await tx.stepPrice.findMany({ where }), chain.steps, materialId),
      partner: pricing.partnerId
        ? {
            partnerStepTypeIds: partnerStepTypes,
            prices: mostSpecific(
              await tx.partnerStepPrice.findMany({ where: { ...where, partnerId: pricing.partnerId } }),
              chain.steps,
              materialId,
            ),
          }
        : undefined,
    };
    const prices = new Map<string, PriceRow>();
    for (const step of chain.steps) {
      const price = pricesFor(source, step.id);
      if (price) prices.set(step.id, price);
    }
    const units = await this.units.all(tx);
    const priced = await this.pricedMaterials(tx, tenantId, evaluation, prices, units);
    if ('reasons' in priced) {
      return { accepted: false, reasons: priced.reasons };
    }

    // 4–7. The engine.
    const { adjustments, groupKey, speedKey } = pricing;
    const profile = await this.profile.get(tx);
    const result = priceConfiguration({
      quantity: request.quantity,
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
      tier: tierFor(adjustments.tiers, request.quantity),
      // A saved quote's group or speed may since have been removed; it then no longer applies.
      groupPercent: groupKey ? (adjustments.groups.get(groupKey) ?? null) : null,
      speedPercent: speedKey ? (adjustments.speeds.get(speedKey) ?? null) : null,
    });
    if (!result.accepted) {
      return { accepted: false, reasons: result.reasons };
    }
    return {
      accepted: true,
      evaluation,
      breakdown: result.breakdown,
      materials: priced.list,
      profile,
      partnerStepKeys: new Set(chain.steps.filter((step) => partnerStepTypes.has(step.id)).map((step) => step.key)),
      chainStepTypeIds: chain.steps.map((step) => step.id),
    };
  }

  /**
   * The configuration's material under `'configuration'`, and every material the steps name, each
   * with its current price; a named material without a usable price refuses the steps that use it.
   */
  private async pricedMaterials(
    tx: Prisma.TransactionClient,
    tenantId: string,
    evaluation: Extract<Evaluation, { accepted: true }>,
    prices: Map<string, PriceRow>,
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

  /** Row-level security hides other workspaces' customers, so a foreign id is not found. */
  private async findCustomer(tx: Prisma.TransactionClient, id: string): Promise<{ groupKey: string | null }> {
    const customer = await tx.customer.findUnique({ where: { id }, select: { customerGroup: { select: { key: true } } } });
    if (!customer) {
      throw new NotFoundException('Customer not found');
    }
    return { groupKey: customer.customerGroup?.key ?? null };
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
    customer_id: row.customerId,
    partner: row.partnerId && row.partnerCost ? { id: row.partnerId, cost: row.partnerCost.toFixed(2) } : null,
    inputs: row.inputs as QuoteInputs,
    materials: row.materials as QuoteMaterial[],
    breakdown: row.breakdown as BreakdownJson,
  };
}
