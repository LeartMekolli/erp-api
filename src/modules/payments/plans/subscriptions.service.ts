import { ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { newId } from '../../../common/ids/uuid';
import { ConfigService } from '../../../config/config.service';
import { PrismaService } from '../../../database/prisma.service';
import type { CustomerSubscription, Prisma } from '../../../generated/prisma/client';
import { lockCustomer } from '../../customers/customers.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { customerBillingLink } from '../../notifications/web-links';
import { PaymentAccountService } from '../payment-account.service';
import { PAYMENT_PROVIDER } from '../payment-provider';
import type { InvoiceReason, PaymentProvider } from '../payment-provider';
import { ProviderCustomers } from '../provider-customers';
import { PLAN_GIVING_STATUSES, planOf } from './plan-of';
import type { PlanBenefits } from './plan-of';
import { isPublished, planInclude, portalPlanResponse } from './plan-response';
import type { PortalPlanListResponse, SubscriptionChange, SubscriptionCheckout, SubscriptionResponse } from './plan-response';
import { isUpgrade } from './plans';
import type { PlanInterval } from './plans';

type SubscriptionEvent =
  | 'subscription.started'
  | 'subscription.changed'
  | 'subscription.downgrade_scheduled'
  | 'subscription.ended'
  | 'subscription.ended.staff';

/** A notice `sync` found to send, once its transaction has committed. */
interface Notice {
  event: SubscriptionEvent;
  variables: Record<string, string>;
}

/** A subscription the customer holds, paid or not yet: a second one can't be bought. */
const HELD_STATUSES = ['incomplete', ...PLAN_GIVING_STATUSES];

const isUuid = (value: string | undefined): value is string => value !== undefined && z.uuid().safeParse(value).success;

/**
 * Runs inside the transaction that changed a customer's plan, under the customer's lock, with the
 * plan before and after (monthly allowances, Task 6; campaigns, Task 8).
 */
export type PlanChangeHook = (
  tx: Prisma.TransactionClient,
  change: { tenantId: string; customerId: string; before: PlanBenefits; after: PlanBenefits; subscription: CustomerSubscription },
) => Promise<void>;

/**
 * Subscriptions to plans (Payments 2 spec, goals 4–6, D47). Customers buy them through the provider's
 * checkout and manage them in its billing portal; `customer_subscription` mirrors the provider and is
 * written only by `sync`, from webhooks.
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);
  private readonly hooks: PlanChangeHook[] = [];
  private readonly afterHooks: ((tenantId: string, customerId: string) => Promise<void>)[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly accounts: PaymentAccountService,
    private readonly providerCustomers: ProviderCustomers,
    private readonly notifications: NotificationsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  onPlanChange(hook: PlanChangeHook): void {
    this.hooks.push(hook);
  }

  /** Runs once the transaction that changed a customer's plan has committed (campaigns, Task 8). */
  afterPlanChange(hook: (tenantId: string, customerId: string) => Promise<void>): void {
    this.afterHooks.push(hook);
  }

  /** The plans a customer can choose: every active one, and its own even when archived. */
  async portalPlans(tenantId: string, customerId: string): Promise<PortalPlanListResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const current = await planOf(tx, customerId);
      const rows = await tx.plan.findMany({
        where: { OR: [{ status: 'active' }, { id: current.id }] },
        include: planInclude,
        orderBy: [{ position: 'asc' }, { key: 'asc' }],
      });
      return { data: rows.map((row) => portalPlanResponse(row, current.id)) };
    });
  }

  async view(tenantId: string, customerId: string): Promise<SubscriptionResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      if (!(await tx.customer.findFirst({ where: { id: customerId }, select: { id: true } }))) {
        throw new NotFoundException('Customer not found');
      }
      const row = await tx.customerSubscription.findFirst({
        where: { customerId, status: { in: HELD_STATUSES } },
        include: { planPrice: { include: { plan: true } }, scheduledPrice: { include: { plan: true } } },
      });
      if (!row) {
        const free = await planOf(tx, customerId);
        return {
          plan: { key: free.key, name: free.name },
          interval: null,
          price: null,
          status: 'free',
          current_period_end: null,
          change: null,
          cancel_at_period_end: false,
        };
      }
      const on = row.currentPeriodEnd.toISOString();
      const free = row.cancelAtPeriodEnd ? await tx.plan.findFirstOrThrow({ where: { isDefault: true } }) : null;
      const scheduled = row.scheduledPrice;
      return {
        plan: { key: row.planPrice.plan.key, name: row.planPrice.plan.name },
        interval: row.planPrice.interval as PlanInterval,
        price: row.planPrice.amount.toFixed(2),
        status: row.status as SubscriptionResponse['status'],
        current_period_end: on,
        change: free
          ? { plan: { key: free.key, name: free.name }, interval: null, on }
          : scheduled
            ? { plan: { key: scheduled.plan.key, name: scheduled.plan.name }, interval: scheduled.interval as PlanInterval, on }
            : null,
        cancel_at_period_end: row.cancelAtPeriodEnd,
      };
    });
  }

  /**
   * A link to the provider's checkout for a paid plan at its current price. Each ask makes a new one,
   * so a tab closed without paying blocks nothing; a subscription held already is a 409.
   */
  async checkout(tenantId: string, customerId: string, input: SubscriptionCheckout): Promise<{ url: string }> {
    const prepared = await this.prisma.inTenant(tenantId, async (tx) => {
      const keys = await this.accounts.keys(tx);
      const held = await tx.customerSubscription.findFirst({ where: { customerId, status: { in: HELD_STATUSES } }, select: { id: true } });
      if (held) throw new ConflictException('The customer already has a subscription; change it in the billing portal');
      const plan = await tx.plan.findFirst({ where: { id: input.plan_id }, include: planInclude });
      if (!plan) throw new NotFoundException('Plan not found');
      if (plan.isDefault) throw new ConflictException('The free plan needs no subscription');
      if (plan.status !== 'active') throw new ConflictException('This plan is no longer sold');
      const price = plan.prices.find((candidate) => candidate.interval === input.interval);
      if (!price?.providerPriceId || !isPublished(plan)) throw new ConflictException('This plan is not ready to be sold yet');
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true, customerSiteOrigin: true } });
      return { keys: keys.keys, price: { id: price.id, providerPriceId: price.providerPriceId }, tenant };
    });

    const target = this.target(prepared.tenant);
    try {
      const providerCustomerId = await this.providerCustomers.ensure(tenantId, customerId);
      const made = await this.provider.createSubscriptionCheckout(prepared.keys, {
        providerCustomerId,
        priceId: prepared.price.providerPriceId,
        successUrl: customerBillingLink(target, '?subscription=done'),
        cancelUrl: customerBillingLink(target, '?subscription=cancelled'),
        metadata: { tenant_id: tenantId, customer_id: customerId, plan_price_id: prepared.price.id },
        idempotencyKey: newId(),
      });
      return { url: made.url };
    } catch (error) {
      this.logger.error({ err: error, tenantId, customerId }, 'the payment provider refused a subscription checkout');
      throw new ServiceUnavailableException('The payment provider is not answering; try again shortly');
    }
  }

  /**
   * Asks the provider to move the customer's subscription to another plan (spec B3): costing as
   * much or more a month, at once on payment (`pending: true`); costing less, at the period end; the
   * free plan, by cancelling at the period end; the current plan and interval, by undoing any of
   * those. Never writes the row itself: `sync` reads what the provider made of it.
   */
  async change(tenantId: string, customerId: string, input: SubscriptionChange): Promise<{ pending: boolean; view: SubscriptionResponse }> {
    const prepared = await this.prisma.inTenant(tenantId, async (tx) => {
      const keys = (await this.accounts.keys(tx)).keys;
      const row = await tx.customerSubscription.findFirst({ where: { customerId, status: { in: HELD_STATUSES } }, include: { planPrice: true } });
      if (!row || row.status === 'incomplete') throw new ConflictException('No subscription to change; subscribe through checkout');
      if (row.status === 'past_due') throw new ConflictException('The last payment is late; update the card in the billing portal first');
      const plan = await tx.plan.findFirst({ where: { id: input.plan_id }, include: planInclude });
      if (!plan) throw new NotFoundException('Plan not found');
      const current = row.planPrice;
      if (plan.isDefault) return { keys, row, action: 'cancel' as const };
      if (plan.id === current.planId && input.interval === current.interval) return { keys, row, action: 'undo' as const };
      if (plan.status !== 'active') throw new ConflictException('This plan is no longer sold');
      const price = plan.prices.find((candidate) => candidate.interval === input.interval);
      if (!price?.providerPriceId || !isPublished(plan)) throw new ConflictException('This plan is not ready to be sold yet');
      const terms = (from: { amount: Prisma.Decimal; interval: string }) => ({ amount: from.amount, interval: from.interval as PlanInterval });
      return {
        keys,
        row,
        action: isUpgrade(terms(current), terms(price)) ? ('upgrade' as const) : ('schedule' as const),
        priceId: price.providerPriceId,
      };
    });

    const { keys, row } = prepared;
    const id = row.providerSubscriptionId;
    try {
      // Whatever was asked before is replaced by this.
      if (prepared.action !== 'cancel' && row.cancelAtPeriodEnd) await this.provider.setCancelAtPeriodEnd(keys, id, false);
      if (row.scheduledPlanPriceId && prepared.action !== 'schedule') {
        await this.provider.scheduleSubscriptionPrice(keys, id, { priceId: null, idempotencyKey: newId() });
      }
      if (prepared.action === 'cancel') await this.provider.setCancelAtPeriodEnd(keys, id, true);
      if (prepared.action === 'upgrade') await this.provider.upgradeSubscription(keys, id, { priceId: prepared.priceId, idempotencyKey: newId() });
      if (prepared.action === 'schedule') {
        await this.provider.scheduleSubscriptionPrice(keys, id, { priceId: prepared.priceId, idempotencyKey: newId() });
      }
    } catch (error) {
      this.logger.error({ err: error, tenantId, customerId }, 'the payment provider refused a subscription change');
      throw new ServiceUnavailableException('The payment provider is not answering; try again shortly');
    }
    await this.sync(tenantId, id);
    return { pending: prepared.action === 'upgrade', view: await this.view(tenantId, customerId) };
  }

  /**
   * A subscription invoice the provider couldn't charge: the customer hears of it once per invoice,
   * as a failed upgrade (the plan stays) or a late payment (the plan stays while the provider retries).
   */
  async paymentFailed(tenantId: string, providerSubscriptionId: string, invoice: { id: string; reason: InvoiceReason | null }): Promise<void> {
    await this.sync(tenantId, providerSubscriptionId);
    const notice = await this.prisma.inTenant(tenantId, async (tx) => {
      const row = await tx.customerSubscription.findFirst({
        where: { providerSubscriptionId },
        include: { planPrice: { include: { plan: true } }, pendingPrice: { include: { plan: true } } },
      });
      if (!row) return null;
      await lockCustomer(tx, row.customerId);
      const kind = invoice.reason === 'update' ? ('upgrade_failed' as const) : ('payment_failed' as const);
      const [created] = await tx.subscriptionNotice.createManyAndReturn({
        data: [{ customerId: row.customerId, kind, providerInvoiceId: invoice.id }],
        skipDuplicates: true,
      });
      if (!created) return null;
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true, customerSiteOrigin: true } });
      return {
        kind,
        customerId: row.customerId,
        plan: (kind === 'upgrade_failed' ? row.pendingPrice?.plan.name : undefined) ?? row.planPrice.plan.name,
        portalUrl: customerBillingLink(this.target(tenant)),
      };
    });
    if (!notice) return;
    await this.tell(tenantId, notice.customerId, () =>
      this.notifications.raise(
        tenantId,
        notice.kind === 'upgrade_failed' ? 'subscription.upgrade_failed' : 'subscription.payment_failed',
        { type: 'customer', id: notice.customerId },
        { plan: notice.plan, portal_url: notice.portalUrl },
      ),
    );
  }

  /** A link to the provider's billing portal, where the owner changes the card, the plan or cancels. */
  async billingPortal(tenantId: string, customerId: string): Promise<{ url: string }> {
    const prepared = await this.prisma.inTenant(tenantId, async (tx) => ({
      keys: (await this.accounts.keys(tx)).keys,
      tenant: await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true, customerSiteOrigin: true } }),
    }));
    try {
      const providerCustomerId = await this.providerCustomers.ensure(tenantId, customerId);
      return await this.provider.billingPortalLink(prepared.keys, {
        providerCustomerId,
        returnUrl: customerBillingLink(this.target(prepared.tenant)),
      });
    } catch (error) {
      this.logger.error({ err: error, tenantId, customerId }, 'the payment provider refused a billing portal link');
      throw new ServiceUnavailableException('The payment provider is not answering; try again shortly');
    }
  }

  /**
   * Makes `customer_subscription` what the provider says now, whatever event brought us here and in
   * whatever order. The only writer of that table. A subscription that isn't ours is ignored.
   */
  async sync(tenantId: string, providerSubscriptionId: string): Promise<void> {
    const keys = (await this.accounts.keysFor(tenantId)).keys;
    const now = await this.provider.getSubscription(keys, providerSubscriptionId);

    const told = await this.prisma.inTenant(tenantId, async (tx): Promise<{ customerId: string; notices: Notice[]; planChanged: boolean } | null> => {
      const byProvider = await tx.customerPaymentTerms.findFirst({
        where: { providerCustomerId: now.providerCustomerId },
        select: { customerId: true },
      });
      const fromMetadata = isUuid(now.metadata.customer_id)
        ? await tx.customer.findFirst({ where: { id: now.metadata.customer_id }, select: { id: true } })
        : null;
      const customerId = byProvider?.customerId ?? fromMetadata?.id;
      const price = await tx.planPrice.findFirst({ where: { providerPriceId: now.priceId }, include: { plan: true } });
      if (!customerId || !price) {
        this.logger.warn({ tenantId, providerSubscriptionId }, 'a subscription not of ours was ignored');
        return null;
      }
      const priceOf = (providerPriceId: string | null) =>
        providerPriceId ? tx.planPrice.findFirst({ where: { providerPriceId }, include: { plan: true } }) : null;
      const scheduled = await priceOf(now.scheduledPriceId);
      const pending = await priceOf(now.pendingPriceId);

      await lockCustomer(tx, customerId);
      const existing = await tx.customerSubscription.findFirst({ where: { customerId } });
      const holding = (row: CustomerSubscription | null) => row !== null && HELD_STATUSES.includes(row.status);
      // An older subscription ending must not overwrite the one the customer holds now.
      if (existing && existing.providerSubscriptionId !== providerSubscriptionId && holding(existing) && now.status === 'ended') {
        return null;
      }
      const fresh = !existing || existing.providerSubscriptionId !== providerSubscriptionId || existing.status === 'ended' || existing.status === 'incomplete';
      const before = await planOf(tx, customerId);
      const data = {
        providerSubscriptionId,
        planPriceId: price.id,
        status: now.status,
        currentPeriodStart: now.currentPeriodStart,
        currentPeriodEnd: now.currentPeriodEnd,
        cancelAtPeriodEnd: now.cancelAtPeriodEnd,
        scheduledPlanPriceId: scheduled?.id ?? null,
        pendingPlanPriceId: pending?.id ?? null,
        // Monthly allowances count from when the subscription became active from no paid plan.
        allowanceAnchor: now.status === 'active' && fresh ? now.currentPeriodStart : (existing?.allowanceAnchor ?? null),
      };
      const row = existing
        ? await tx.customerSubscription.update({ where: { id: existing.id }, data })
        : await tx.customerSubscription.create({ data: { customerId, ...data } });
      const after = await planOf(tx, customerId);
      if (before.id !== after.id) {
        for (const hook of this.hooks) await hook(tx, { tenantId, customerId, before, after, subscription: row });
      }

      // What changed, each told once: a repeat of the same state finds nothing new.
      const notices: Notice[] = [];
      if (now.status === 'active' && fresh) {
        notices.push({
          event: 'subscription.started',
          variables: { plan: price.plan.name, interval: price.interval, price: `${price.amount.toFixed(2)} ${price.currency}` },
        });
      } else if (!fresh && before.id !== after.id && !after.isDefault) {
        notices.push({ event: 'subscription.changed', variables: { plan: after.name } });
      }
      if (scheduled && scheduled.id !== existing?.scheduledPlanPriceId && !fresh) {
        notices.push({
          event: 'subscription.downgrade_scheduled',
          variables: { plan: scheduled.plan.name, on: now.currentPeriodEnd.toISOString().slice(0, 10) },
        });
      }
      if (now.status === 'ended' && existing?.providerSubscriptionId === providerSubscriptionId && existing.status !== 'ended') {
        const customer = await tx.customer.findUniqueOrThrow({ where: { id: customerId }, select: { name: true } });
        const terms = await tx.customerPaymentTerms.findUnique({ where: { customerId }, select: { terms: true } });
        notices.push(
          { event: 'subscription.ended', variables: { plan: price.plan.name } },
          {
            event: 'subscription.ended.staff',
            variables: { customer: customer.name, plan: price.plan.name, pay_later: terms?.terms === 'pay_later' ? 'yes' : 'no' },
          },
        );
      }
      return { customerId, notices, planChanged: before.id !== after.id };
    });

    if (!told) return;
    for (const notice of told.notices) {
      await this.tell(tenantId, told.customerId, () =>
        this.notifications.raise(tenantId, notice.event, { type: 'customer', id: told.customerId }, notice.variables as never),
      );
    }
    if (told.planChanged) {
      for (const hook of this.afterHooks) {
        // The plan change stands; a hook failing is logged, and its own job catches up.
        await this.tell(tenantId, told.customerId, () => hook(tenantId, told.customerId));
      }
    }
  }

  /** The customer of one of our subscriptions, by its provider id; null when it isn't ours. */
  async subscriptionOf(tenantId: string, providerSubscriptionId: string): Promise<CustomerSubscription | null> {
    return this.prisma.inTenant(tenantId, (tx) => tx.customerSubscription.findFirst({ where: { providerSubscriptionId } }));
  }

  /** A step after a committed change (a notice, a hook); failing never undoes the change. */
  private async tell(tenantId: string, customerId: string, step: () => Promise<unknown>): Promise<void> {
    try {
      await step();
    } catch (error) {
      this.logger.error({ err: error, tenantId, customerId }, 'a notice about a subscription failed');
    }
  }

  private target(tenant: { slug: string; customerSiteOrigin: string | null }) {
    return { webTemplate: this.config.get('WEB_URL_TEMPLATE'), slug: tenant.slug, customerSiteOrigin: tenant.customerSiteOrigin };
  }
}
