import { Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import type { PaymentEvent, Prisma } from '../../generated/prisma/client';
import { partnerPortalLink } from '../notifications/web-links';
import type { PayoutAccountState } from '../partners/partner-response';
import { PaymentAccountService } from './payment-account.service';
import { registerEventHandler } from './payment-events.service';
import { PAYMENT_PROVIDER } from './payment-provider';
import type { PaymentProvider } from './payment-provider';
import type { PayoutAccountResponse, PayoutLinkResponse } from './payment-response';

/**
 * The accounts partners are paid through (Payments spec): an account at the provider, made with the
 * first onboarding link and kept up to date by the provider's `account.updated` events on the connect
 * endpoint. The provider's id stays with us.
 */
@Injectable()
export class PayoutAccountsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly accounts: PaymentAccountService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  onModuleInit(): void {
    registerEventHandler('account.updated', (tenantId, event) => this.updated(tenantId, event));
  }

  async state(tenantId: string, partnerId: string): Promise<PayoutAccountResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      await this.partner(tx, partnerId);
      const row = await tx.partnerPayoutAccount.findUnique({ where: { partnerId }, select: { state: true } });
      return { state: (row?.state ?? 'not_connected') as PayoutAccountState };
    });
  }

  /**
   * A fresh onboarding link at the provider. The first one makes the partner's account there, with the
   * partner's id as the idempotency key, so asking twice at once still makes one.
   */
  async link(tenantId: string, partnerId: string): Promise<PayoutLinkResponse> {
    const keys = (await this.accounts.keysFor(tenantId)).keys;
    const prepared = await this.prisma.inTenant(tenantId, async (tx) => {
      const partner = await this.partner(tx, partnerId);
      const existing = await tx.partnerPayoutAccount.findUnique({ where: { partnerId }, select: { providerAccountId: true } });
      // Who the provider writes to about the account: the partner's first active owner.
      const owner = await tx.organisationMembership.findFirst({
        where: { organisationType: 'partner', organisationId: partnerId, role: 'owner', user: { status: 'active' } },
        orderBy: { id: 'asc' },
        select: { user: { select: { email: true } } },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true } });
      return { partner, accountId: existing?.providerAccountId ?? null, email: owner?.user.email ?? null, slug: tenant.slug };
    });

    let accountId = prepared.accountId;
    if (!accountId) {
      const made = await this.provider.createPartnerAccount(keys, {
        partnerId,
        name: prepared.partner.name,
        email: prepared.email,
        idempotencyKey: partnerId,
      });
      accountId = made.id;
      await this.prisma.inTenant(tenantId, (tx) =>
        tx.partnerPayoutAccount.createMany({ data: [{ partnerId, providerAccountId: made.id, state: 'onboarding' }], skipDuplicates: true }),
      );
    }
    const target = { webTemplate: this.config.get('WEB_URL_TEMPLATE'), slug: prepared.slug };
    const link = await this.provider.partnerOnboardingLink(keys, accountId, {
      returnUrl: partnerPortalLink(target, partnerId, '/payout-account?onboarding=done'),
      refreshUrl: partnerPortalLink(target, partnerId, '/payout-account?onboarding=expired'),
    });
    return { url: link.url, expires_at: link.expiresAt.toISOString() };
  }

  /** The provider's word on a connected account; one not ours, or not from the connect endpoint, is ignored. */
  async updated(tenantId: string, event: PaymentEvent): Promise<void> {
    if (event.endpoint !== 'connect') return;
    const accountId = event.connectedAccountId ?? event.objectId;
    const row = await this.prisma.inTenant(tenantId, (tx) =>
      tx.partnerPayoutAccount.findFirst({ where: { providerAccountId: accountId }, select: { partnerId: true } }),
    );
    if (!row) return;
    const { state } = await this.provider.getPartnerAccount((await this.accounts.keysFor(tenantId)).keys, accountId);
    await this.prisma.inTenant(tenantId, (tx) => tx.partnerPayoutAccount.update({ where: { partnerId: row.partnerId }, data: { state } }));
  }

  /** Row-level security hides other workspaces' partners, so a foreign id is simply not found. */
  private async partner(tx: Prisma.TransactionClient, partnerId: string): Promise<{ name: string }> {
    const partner = await tx.partner.findUnique({ where: { id: partnerId }, select: { name: true } });
    if (!partner) throw new NotFoundException('Partner not found');
    return partner;
  }
}
