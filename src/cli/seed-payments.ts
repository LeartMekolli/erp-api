import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../database/prisma.service';
import type { PaymentAccountService } from '../modules/payments/payment-account.service';
import type { PayoutAccountsService } from '../modules/payments/payout-accounts.service';

// Demo payments for the demo workspace, on top of its customers and partners (`seed-customers.ts`,
// `seed-partners.ts`): Luna Jewels pays first, Brightline pays later within a limit, and, with the
// demo's Stripe test keys, the workspace's payment account and Northcast's payout account.

const PAY_FIRST = 'Luna Jewels';
const PAY_LATER = { name: 'Brightline', daysToPay: 30, creditLimit: '5000.00' };
const PAID_PARTNER = 'Northcast Foundry';

export interface DemoStripeKeys {
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
  connectWebhookSecret: string;
}

export interface PaymentsSeedCounts {
  /** 1 when the payment account was set, 0 without keys or when the workspace had one. */
  account: number;
  customers: number;
  terms: number;
  payoutAccounts: number;
}

/**
 * Seeds the demo payments into one workspace. Idempotent: a customer is found by name, its terms by
 * customer, the payment account and a payout account by workspace and partner; anything found is left
 * as it is. Without keys, the payment account and the payout account are skipped. The payout account
 * is made at the provider, so the seed calls it (Stripe in test mode, or the fake).
 */
export async function seedPayments(
  deps: { prisma: PrismaService; accounts: PaymentAccountService; payoutAccounts: PayoutAccountsService },
  tenantId: string,
  keys: DemoStripeKeys | null,
): Promise<PaymentsSeedCounts> {
  const { prisma } = deps;
  const created: PaymentsSeedCounts = { account: 0, customers: 0, terms: 0, payoutAccounts: 0 };

  await prisma.inTenant(tenantId, async (tx) => {
    let brightline = await tx.customer.findFirst({ where: { name: PAY_LATER.name } });
    if (!brightline) {
      brightline = await tx.customer.create({ data: { name: PAY_LATER.name } });
      created.customers++;
    }
    const terms = [
      { customerId: (await tx.customer.findFirst({ where: { name: PAY_FIRST } }))?.id, terms: 'pay_first', daysToPay: 30, creditLimit: null },
      { customerId: brightline.id, terms: 'pay_later', daysToPay: PAY_LATER.daysToPay, creditLimit: new Prisma.Decimal(PAY_LATER.creditLimit) },
    ];
    for (const row of terms) {
      if (!row.customerId || (await tx.customerPaymentTerms.findUnique({ where: { customerId: row.customerId } }))) continue;
      await tx.customerPaymentTerms.create({
        data: { customerId: row.customerId, terms: row.terms, daysToPay: row.daysToPay, creditLimit: row.creditLimit },
      });
      created.terms++;
    }

    if (keys && !(await tx.paymentAccount.findFirst({ select: { tenantId: true } }))) {
      await deps.accounts.set(tx, tenantId, { type: 'system' }, {
        secret_key: keys.secretKey,
        publishable_key: keys.publishableKey,
        webhook_secret: keys.webhookSecret,
        connect_webhook_secret: keys.connectWebhookSecret,
      });
      created.account++;
    }
  });

  if (!keys) return created;
  // Outside the transaction: the provider is called, and the account must be committed first.
  const partner = await prisma.inTenant(tenantId, (tx) =>
    tx.partner.findFirst({ where: { name: PAID_PARTNER }, select: { id: true, payoutAccount: { select: { partnerId: true } } } }),
  );
  if (partner && !partner.payoutAccount) {
    await deps.payoutAccounts.link(tenantId, partner.id);
    created.payoutAccounts++;
  }
  return created;
}
