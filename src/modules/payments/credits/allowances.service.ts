import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import type { CustomerSubscription, Prisma } from '../../../generated/prisma/client';
import { lockCustomer } from '../../customers/customers.service';
import { PLAN_GIVING_STATUSES, planOf } from '../plans/plan-of';
import type { PlanBenefits } from '../plans/plan-of';
import { SubscriptionsService } from '../plans/subscriptions.service';
import { allowanceMonth } from './allowance-month';
import type { AllowanceClock } from './allowance-month';
import { CreditsService } from './credits.service';

/**
 * Monthly credit allowances (Payments 2 spec, goal 9): each month of a customer's plan brings its
 * `monthly_credits`, expiring at the month's end, granted once per month by its source key. They
 * follow the plan: a change replaces or tops up the month's allowance.
 */
@Injectable()
export class AllowancesService implements OnModuleInit {
  private readonly logger = new Logger(AllowancesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  onModuleInit(): void {
    this.subscriptions.onPlanChange((tx, change) =>
      this.onPlanChange(tx, change.customerId, change.before, change.after, change.subscription, new Date()),
    );
  }

  /**
   * The caller holds the customer's lock. Grants the allowance of the month containing `at`, unless
   * it is granted already or the plan gives none. A paid plan gives a month only while its
   * subscription is active and has paid for `at`: a late payment brings nothing new until it is paid.
   */
  async grantDue(tx: Prisma.TransactionClient, customerId: string, at: Date): Promise<boolean> {
    const plan = await planOf(tx, customerId);
    if (plan.monthlyCredits <= 0) return false;
    const clock = await this.clockOf(tx, customerId, at);
    if (!clock) return false;
    const month = allowanceMonth(at, clock);
    const { created } = await this.credits.grant(tx, {
      customerId,
      source: 'allowance',
      amount: plan.monthlyCredits,
      expiresAt: month.end,
      sourceKey: `allowance:${customerId}:${month.start.toISOString()}`,
    });
    return created;
  }

  /**
   * `sync`'s hook, inside its transaction. Between the free plan and a paid one, what is left of the
   * old allowance ends and the new plan's month begins; to a paid plan with more credits, the
   * difference is topped up for the rest of the month. A move to fewer credits, which happens at a
   * renewal, waits for that month's allowance.
   */
  async onPlanChange(
    tx: Prisma.TransactionClient,
    customerId: string,
    before: PlanBenefits,
    after: PlanBenefits,
    subscription: CustomerSubscription,
    at: Date,
  ): Promise<void> {
    if (before.isDefault !== after.isDefault) {
      await this.credits.writeOff(tx, customerId, 'allowance');
      await this.grantDue(tx, customerId, at);
      return;
    }
    const more = after.monthlyCredits - before.monthlyCredits;
    const clock = await this.clockOf(tx, customerId, at);
    if (more > 0 && clock?.kind === 'paid') {
      const month = allowanceMonth(at, clock);
      await this.credits.grant(tx, {
        customerId,
        source: 'allowance',
        amount: more,
        expiresAt: month.end,
        sourceKey: `topup:${customerId}:${month.start.toISOString()}:${subscription.planPriceId}`,
      });
    }
    await this.grantDue(tx, customerId, at);
  }

  /** The scheduled job (`payments.credits.allowances`): every active workspace, as at `at`. */
  async grantDueEverywhere(at: Date): Promise<void> {
    const tenants = await this.prisma.tenant.findMany({ where: { status: 'active' }, select: { id: true } });
    for (const tenant of tenants) {
      try {
        await this.grantDueInWorkspace(tenant.id, at);
      } catch (error) {
        this.logger.error({ err: error, tenantId: tenant.id }, 'granting allowances failed');
      }
    }
  }

  /**
   * Every customer of the workspace that may be owed a month at `at`: all of them when the free plan
   * gives credits, else those with an active subscription. Customer by customer, under its lock.
   */
  async grantDueInWorkspace(tenantId: string, at: Date): Promise<void> {
    const customers = await this.prisma.inTenant(tenantId, async (tx) => {
      const free = await tx.plan.findFirstOrThrow({ where: { isDefault: true }, select: { monthlyCredits: true } });
      return tx.customer.findMany({
        where: { status: 'active', ...(free.monthlyCredits > 0 ? {} : { subscription: { status: 'active' } }) },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
    });
    for (const { id } of customers) {
      // One customer failing must not keep the others' allowances back.
      try {
        await this.prisma.inTenant(tenantId, async (tx) => {
          await lockCustomer(tx, id);
          await this.grantDue(tx, id, at);
        });
      } catch (error) {
        this.logger.error({ err: error, tenantId, customerId: id }, 'granting an allowance failed');
      }
    }
  }

  /**
   * How the customer's months are counted at `at`; null when a paid plan has nothing to give then:
   * its subscription isn't active, or no paid invoice covers `at` yet (a monthly one waits for its
   * renewal to be charged, which the provider does after the new period has begun).
   */
  private async clockOf(tx: Prisma.TransactionClient, customerId: string, at: Date): Promise<AllowanceClock | null> {
    const subscription = await tx.customerSubscription.findFirst({
      where: { customerId, status: { in: [...PLAN_GIVING_STATUSES] } },
    });
    if (!subscription) {
      const { timezone } = await tx.tenant.findFirstOrThrow({ select: { timezone: true } });
      return { kind: 'free', timezone };
    }
    const anchor = subscription.allowanceAnchor ?? subscription.currentPeriodStart;
    if (subscription.status !== 'active' || at < anchor || at >= subscription.currentPeriodEnd) return null;
    const paid = await tx.subscriptionPaidPeriod.findFirst({
      where: { providerSubscriptionId: subscription.providerSubscriptionId, periodStart: { lte: at }, periodEnd: { gt: at } },
      select: { id: true },
    });
    if (!paid) return null;
    return { kind: 'paid', anchor };
  }
}
