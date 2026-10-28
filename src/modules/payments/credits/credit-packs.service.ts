import { ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '../../../config/config.service';
import { PrismaService } from '../../../database/prisma.service';
import { Prisma } from '../../../generated/prisma/client';
import type { CreditPack } from '../../../generated/prisma/client';
import { AuditService } from '../../audit/audit.service';
import type { CustomerAuth, TenantAuth } from '../../identity/auth-context';
import { customerBillingLink } from '../../notifications/web-links';
import { PaymentAccountService } from '../payment-account.service';
import { PAYMENT_PROVIDER } from '../payment-provider';
import type { PaymentProvider } from '../payment-provider';
import type { CreateCreditPack, CreditPackListResponse, CreditPackResponse, UpdateCreditPack } from './credit-response';

/** How long a pack's checkout stays open: just under the day the provider allows at most. */
const CHECKOUT_OPEN_MS = 23 * 3_600_000;

function packResponse(row: CreditPack): CreditPackResponse {
  return {
    id: row.id,
    name: row.name,
    credits: row.credits,
    price: row.price.toFixed(2),
    currency: row.currency,
    valid_days: row.validDays,
    position: row.position,
    status: row.status as CreditPackResponse['status'],
  };
}

const ordered = [{ position: 'asc' as const }, { id: 'asc' as const }];

/**
 * Credit packs (Payments 2 spec, goal 10): workspace data staff manage, bought once by a customer's
 * owner on any plan, through a checkout for the amount on our own row. The credits come with the
 * provider's word that it is paid (`PackEvents`).
 */
@Injectable()
export class CreditPacksService {
  private readonly logger = new Logger(CreditPacksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly accounts: PaymentAccountService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async list(tenantId: string): Promise<CreditPackListResponse> {
    const rows = await this.prisma.inTenant(tenantId, (tx) => tx.creditPack.findMany({ orderBy: ordered }));
    return { data: rows.map(packResponse) };
  }

  /** The packs a customer can buy now. */
  async forSale(tenantId: string): Promise<CreditPackListResponse> {
    const rows = await this.prisma.inTenant(tenantId, (tx) => tx.creditPack.findMany({ where: { status: 'active' }, orderBy: ordered }));
    return { data: rows.map(packResponse) };
  }

  async create(auth: TenantAuth, input: CreateCreditPack): Promise<CreditPackResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const { defaultCurrency: currency } = await tx.tenant.findFirstOrThrow({ select: { defaultCurrency: true } });
      const row = await tx.creditPack.create({
        data: {
          name: input.name,
          credits: input.credits,
          price: new Prisma.Decimal(input.price),
          currency,
          validDays: input.valid_days,
          position: input.position,
        },
      });
      const after = packResponse(row);
      await this.record(tx, auth, row.id, undefined, after);
      return after;
    });
  }

  async update(auth: TenantAuth, id: string, patch: UpdateCreditPack): Promise<CreditPackResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM credit_pack WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.creditPack.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('Credit pack not found');
      const row = await tx.creditPack.update({
        where: { id },
        data: {
          name: patch.name,
          credits: patch.credits,
          price: patch.price === undefined ? undefined : new Prisma.Decimal(patch.price),
          validDays: patch.valid_days,
          position: patch.position,
          status: patch.status,
        },
      });
      const after = packResponse(row);
      await this.record(tx, auth, id, packResponse(current), after);
      return after;
    });
  }

  /**
   * A link to pay for a pack: the purchase is written first with what the pack is now, then the
   * provider is asked for a checkout of that amount, with the purchase's id as the idempotency key.
   */
  async buy(customer: CustomerAuth, packId: string): Promise<{ url: string }> {
    const { tenantId, customerId } = customer;
    const prepared = await this.prisma.inTenant(tenantId, async (tx) => {
      const keys = (await this.accounts.keys(tx)).keys;
      const pack = await tx.creditPack.findFirst({ where: { id: packId } });
      if (!pack) throw new NotFoundException('Credit pack not found');
      if (pack.status !== 'active') throw new ConflictException('This pack is no longer sold');
      const purchase = await tx.creditPackPurchase.create({
        data: {
          customerId,
          packId,
          credits: pack.credits,
          price: pack.price,
          currency: pack.currency,
          validDays: pack.validDays,
          createdByUserId: customer.userId,
        },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true, customerSiteOrigin: true } });
      return { keys, pack, purchase, tenant };
    });

    const { keys, pack, purchase, tenant } = prepared;
    const target = { webTemplate: this.config.get('WEB_URL_TEMPLATE'), slug: tenant.slug, customerSiteOrigin: tenant.customerSiteOrigin };
    let checkout: { id: string; url: string };
    try {
      checkout = await this.provider.createCheckout(keys, {
        amount: purchase.price,
        currency: purchase.currency,
        description: pack.name,
        expiresAt: new Date(Date.now() + CHECKOUT_OPEN_MS),
        successUrl: customerBillingLink(target, '?pack=done'),
        cancelUrl: customerBillingLink(target, '?pack=cancelled'),
        metadata: { tenant_id: tenantId, customer_id: customerId, credit_pack_purchase_id: purchase.id },
        idempotencyKey: purchase.id,
      });
    } catch (error) {
      // Never payable: the next ask makes a new purchase.
      await this.prisma.inTenant(tenantId, (tx) =>
        tx.creditPackPurchase.updateMany({ where: { id: purchase.id, status: 'open' }, data: { status: 'expired' } }),
      );
      this.logger.error({ err: error, tenantId, customerId }, 'the payment provider refused a pack checkout');
      throw new ServiceUnavailableException('The payment provider is not answering; try again shortly');
    }
    await this.prisma.inTenant(tenantId, (tx) =>
      tx.creditPackPurchase.update({ where: { id: purchase.id }, data: { providerCheckoutId: checkout.id } }),
    );
    return { url: checkout.url };
  }

  private async record(
    tx: Prisma.TransactionClient,
    auth: TenantAuth,
    id: string,
    before: CreditPackResponse | undefined,
    after: CreditPackResponse,
  ): Promise<void> {
    await this.audit.record(tx, {
      actor: { type: 'user', id: auth.userId },
      action: 'credit_pack.changed',
      subject: { type: 'credit_pack', id },
      before,
      after,
    });
  }
}
