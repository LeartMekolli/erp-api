import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../audit/audit.service';
import type { TenantAuth } from '../../identity/auth-context';
import { conflictOnDuplicate } from '../../pricing/decimals';
import { PaymentAccountService } from '../payment-account.service';
import { PAYMENT_PROVIDER } from '../payment-provider';
import type { PaymentProvider } from '../payment-provider';
import { planInclude, planResponse } from './plan-response';
import type { CreatePlan, PlanListResponse, PlanResponse, UpdatePlan } from './plan-response';
import type { PlanInterval } from './plans';

type SpeedInput = CreatePlan['speeds'];

/**
 * Plans as workspace data (Payments 2 spec, goals 1–3). Every save publishes what is new to the
 * provider after its commit: a product per paid plan and a recurring price per amount.
 */
@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accounts: PaymentAccountService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async list(tenantId: string): Promise<PlanListResponse> {
    const rows = await this.prisma.inTenant(tenantId, (tx) =>
      tx.plan.findMany({ include: planInclude, orderBy: [{ position: 'asc' }, { key: 'asc' }] }),
    );
    return { data: rows.map(planResponse) };
  }

  async create(auth: TenantAuth, input: CreatePlan): Promise<PlanResponse> {
    const id = await this.prisma
      .inTenant(auth.tenantId, async (tx) => {
        const { defaultCurrency: currency } = await tx.tenant.findFirstOrThrow({ select: { defaultCurrency: true } });
        const plan = await tx.plan.create({
          data: {
            key: input.key,
            name: input.name,
            description: input.description,
            position: input.position,
            currency,
            discountPercent: new Prisma.Decimal(input.discount_percent),
            monthlyCredits: input.monthly_credits,
            memberLimit: input.member_limit,
            features: input.features,
          },
        });
        await this.replaceSpeeds(tx, plan.id, input.speeds);
        await tx.planPrice.createMany({
          data: [
            { planId: plan.id, interval: 'month', amount: new Prisma.Decimal(input.monthly_price), currency },
            { planId: plan.id, interval: 'year', amount: new Prisma.Decimal(input.yearly_price), currency },
          ],
        });
        await this.record(tx, auth, plan.id, undefined, await this.view(tx, plan.id));
        return plan.id;
      })
      .catch((error: unknown) => conflictOnDuplicate(error, `A plan with key ${input.key} already exists`));
    return this.publishThenView(auth.tenantId, id);
  }

  async update(auth: TenantAuth, id: string, patch: UpdatePlan): Promise<PlanResponse> {
    await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const plan = await this.lock(tx, id);
      if (plan.isDefault && (patch.monthly_price !== undefined || patch.yearly_price !== undefined)) {
        throw new BadRequestException('The free default plan has no price');
      }
      const before = await this.view(tx, id);
      await tx.plan.update({
        where: { id },
        data: {
          name: patch.name,
          description: patch.description,
          position: patch.position,
          discountPercent: patch.discount_percent === undefined ? undefined : new Prisma.Decimal(patch.discount_percent),
          monthlyCredits: patch.monthly_credits,
          memberLimit: patch.member_limit,
          features: patch.features,
        },
      });
      if (patch.speeds !== undefined) await this.replaceSpeeds(tx, id, patch.speeds);
      if (patch.monthly_price !== undefined) await this.changePrice(tx, id, plan.currency, 'month', patch.monthly_price);
      if (patch.yearly_price !== undefined) await this.changePrice(tx, id, plan.currency, 'year', patch.yearly_price);
      await this.record(tx, auth, id, before, await this.view(tx, id));
    });
    return this.publishThenView(auth.tenantId, id);
  }

  /** Takes no new subscribers; existing ones keep the plan. The default plan is never archived. */
  async archive(auth: TenantAuth, id: string): Promise<PlanResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const plan = await this.lock(tx, id);
      if (plan.isDefault) throw new ConflictException('The free default plan cannot be archived');
      const before = await this.view(tx, id);
      await tx.plan.update({ where: { id }, data: { status: 'archived' } });
      const after = await this.view(tx, id);
      await this.record(tx, auth, id, before, after);
      return after;
    });
  }

  /**
   * Creates at the provider every product and current price not there yet, each with its row id as
   * the idempotency key, outside any transaction. Without keys, nothing happens: the plans stay
   * unpublished until the next save or sync.
   */
  async publish(tenantId: string): Promise<void> {
    const found = await this.prisma.inTenant(tenantId, async (tx) => {
      const account = await this.accounts.find(tx);
      if (!account) return null;
      const plans = await tx.plan.findMany({
        where: { isDefault: false, prices: { some: { active: true, providerPriceId: null } } },
        include: { prices: { where: { active: true, providerPriceId: null } } },
      });
      return { keys: account.keys, plans };
    });
    if (!found) return;

    for (const plan of found.plans) {
      let productId = plan.providerProductId;
      if (!productId) {
        productId = (await this.provider.ensureProduct(found.keys, { name: plan.name, idempotencyKey: plan.id })).id;
        const made = productId;
        await this.prisma.inTenant(tenantId, (tx) =>
          tx.plan.updateMany({ where: { id: plan.id, providerProductId: null }, data: { providerProductId: made } }),
        );
      }
      for (const price of plan.prices) {
        const { id: priceId } = await this.provider.createPrice(found.keys, {
          productId,
          amount: price.amount,
          currency: price.currency,
          interval: price.interval as PlanInterval,
          idempotencyKey: price.id,
        });
        await this.prisma.inTenant(tenantId, (tx) =>
          tx.planPrice.updateMany({ where: { id: price.id, providerPriceId: null }, data: { providerPriceId: priceId } }),
        );
      }
    }
  }

  private async publishThenView(tenantId: string, id: string): Promise<PlanResponse> {
    try {
      await this.publish(tenantId);
    } catch (error) {
      // The save stands; the next save or a sync publishes it.
      this.logger.warn(`Publishing plans failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.prisma.inTenant(tenantId, (tx) => this.view(tx, id));
  }

  /** A new amount deactivates the current price and adds one; the same amount changes nothing. */
  private async changePrice(
    tx: Prisma.TransactionClient,
    planId: string,
    currency: string,
    interval: PlanInterval,
    amount: string,
  ): Promise<void> {
    const next = new Prisma.Decimal(amount);
    const current = await tx.planPrice.findFirst({ where: { planId, interval, active: true } });
    if (current?.amount.equals(next)) return;
    if (current) await tx.planPrice.update({ where: { id: current.id }, data: { active: false } });
    await tx.planPrice.create({ data: { planId, interval, amount: next, currency } });
  }

  private async replaceSpeeds(tx: Prisma.TransactionClient, planId: string, speeds: SpeedInput): Promise<void> {
    const rows = await tx.deliverySpeed.findMany({ where: { key: { in: speeds.map((speed) => speed.key) } } });
    const byKey = new Map(rows.map((row) => [row.key, row.id]));
    const unknown = speeds.find((speed) => !byKey.has(speed.key));
    if (unknown) throw new BadRequestException(`speeds: ${unknown.key} is not a delivery speed of this workspace`);
    await tx.planSpeed.deleteMany({ where: { planId } });
    await tx.planSpeed.createMany({
      data: speeds.map((speed) => ({
        planId,
        deliverySpeedId: byKey.get(speed.key)!,
        surchargePercent: speed.surcharge_percent === null ? null : new Prisma.Decimal(speed.surcharge_percent),
      })),
    });
  }

  /** Row-level security hides other workspaces' plans, so a foreign id is simply not found. */
  private async lock(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT id FROM plan WHERE id = ${id}::uuid FOR UPDATE`;
    const plan = await tx.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('Plan not found');
    return plan;
  }

  private async view(tx: Prisma.TransactionClient, id: string): Promise<PlanResponse> {
    return planResponse(await tx.plan.findUniqueOrThrow({ where: { id }, include: planInclude }));
  }

  /** Audited without `published`, which follows the provider, not the change. */
  private async record(
    tx: Prisma.TransactionClient,
    auth: TenantAuth,
    id: string,
    before: PlanResponse | undefined,
    after: PlanResponse,
  ): Promise<void> {
    const strip = ({ published: _published, ...rest }: PlanResponse) => rest;
    await this.audit.record(tx, {
      actor: { type: 'user', id: auth.userId },
      action: 'plan.changed',
      subject: { type: 'plan', id },
      before: before ? strip(before) : undefined,
      after: strip(after),
    });
  }
}
