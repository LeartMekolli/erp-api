import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import type { PaymentEvent } from '../../../generated/prisma/client';
import { lockCustomer } from '../../customers/customers.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { feeJournal, packBilledJournal, receivedJournal } from '../ledger';
import { LedgerService } from '../ledger.service';
import { PaymentAccountService } from '../payment-account.service';
import { registerEventHandler } from '../payment-events.service';
import { PAYMENT_PROVIDER } from '../payment-provider';
import type { PaymentProvider } from '../payment-provider';
import { CreditsService } from './credits.service';

const OWNER = 'packs';
const DAY_MS = 86_400_000;

/**
 * The checkout webhooks of credit packs (Payments 2 spec, goal 10). Each acts only on a checkout of
 * one of our purchases, reads it from the provider, and is safe to run twice: the grant is keyed by
 * the purchase and each journal posts once per checkout.
 */
@Injectable()
export class PackEvents implements OnModuleInit {
  private readonly logger = new Logger(PackEvents.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: PaymentAccountService,
    private readonly ledger: LedgerService,
    private readonly credits: CreditsService,
    private readonly notifications: NotificationsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  onModuleInit(): void {
    registerEventHandler('checkout.session.completed', (tenantId, event) => this.paid(tenantId, event), OWNER);
    registerEventHandler('checkout.session.async_payment_succeeded', (tenantId, event) => this.paid(tenantId, event), OWNER);
    registerEventHandler('checkout.session.expired', (tenantId, event) => this.expired(tenantId, event), OWNER);
  }

  /**
   * A purchase's checkout the provider says is paid: under the customer's lock the purchase is paid,
   * its credits granted to last `valid_days` from payment, and the sale, payment and fee journalled.
   */
  async paid(tenantId: string, event: PaymentEvent): Promise<void> {
    const purchase = await this.purchaseOf(tenantId, event.objectId);
    if (!purchase) return;
    const checkout = await this.provider.getCheckout((await this.accounts.keysFor(tenantId)).keys, event.objectId);
    if (!checkout.paid) return;

    const granted = await this.prisma.inTenant(tenantId, async (tx) => {
      await lockCustomer(tx, purchase.customerId);
      const row = await tx.creditPackPurchase.findUniqueOrThrow({ where: { id: purchase.id } });
      const paidAt = row.paidAt ?? new Date();
      if (row.status !== 'paid') {
        await tx.creditPackPurchase.update({ where: { id: row.id }, data: { status: 'paid', paidAt } });
      }
      const expiresAt = new Date(paidAt.getTime() + row.validDays * DAY_MS);
      const grant = await this.credits.grant(tx, {
        customerId: row.customerId,
        source: 'pack',
        amount: row.credits,
        expiresAt,
        sourceKey: `pack:${row.id}`,
        packPurchaseId: row.id,
      });
      const common = { occurredAt: paidAt, currency: row.currency, customerId: row.customerId, providerObjectId: event.objectId };
      await this.ledger.post(tx, { ...packBilledJournal(row.customerId, row.price), ...common, memo: `${row.credits} credits billed` });
      await this.ledger.post(tx, {
        ...receivedJournal(row.customerId, checkout.amount, 'stripe_balance'),
        ...common,
        memo: `${row.credits} credits paid`,
      });
      if (checkout.fee.gt(0)) {
        await this.ledger.post(tx, { ...feeJournal(checkout.fee), ...common, memo: `Fee on ${row.credits} credits` });
      }
      return grant.created ? { customerId: row.customerId, credits: row.credits, expiresAt } : null;
    });

    if (!granted) return;
    try {
      await this.notifications.raise(tenantId, 'credits.added', { type: 'customer', id: granted.customerId }, {
        credits: String(granted.credits),
        source: 'pack',
        expires_on: granted.expiresAt.toISOString().slice(0, 10),
      });
    } catch (error) {
      this.logger.error({ err: error, tenantId, customerId: granted.customerId }, 'telling of added credits failed');
    }
  }

  /** A purchase's checkout that expired unpaid: the purchase is expired, and nothing is granted. */
  async expired(tenantId: string, event: PaymentEvent): Promise<void> {
    const purchase = await this.purchaseOf(tenantId, event.objectId);
    if (!purchase) return;
    const checkout = await this.provider.getCheckout((await this.accounts.keysFor(tenantId)).keys, event.objectId);
    if (checkout.status !== 'expired') return;
    await this.prisma.inTenant(tenantId, (tx) =>
      tx.creditPackPurchase.updateMany({ where: { id: purchase.id, status: 'open' }, data: { status: 'expired' } }),
    );
  }

  /** Our purchase for the provider's checkout; another's checkout, or an order's, is not ours. */
  private purchaseOf(tenantId: string, providerCheckoutId: string) {
    return this.prisma.inTenant(tenantId, (tx) =>
      tx.creditPackPurchase.findFirst({ where: { providerCheckoutId }, select: { id: true, customerId: true } }),
    );
  }
}
