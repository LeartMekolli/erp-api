import { ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { decodeCursor } from '../../common/pagination/cursor';
import { toPage } from '../../common/pagination/page';
import type { PaginationQuery } from '../../common/pagination/page';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import type { PaymentEvent, Prisma } from '../../generated/prisma/client';
import { JobsService as QueueService } from '../../jobs/jobs.service';
import type { TenantAuth } from '../identity/auth-context';
import { NotificationsService } from '../notifications/notifications.service';
import { JobsService } from '../partners/jobs.service';
import { lockPartner } from '../partners/partners.service';
import { buildJournal } from './ledger';
import { LedgerService } from './ledger.service';
import { PaymentAccountService } from './payment-account.service';
import { registerEventHandler } from './payment-events.service';
import { PAYMENT_PROVIDER, ProviderRefusedError } from './payment-provider';
import type { PaymentProvider } from './payment-provider';
import type { PayoutPageResponse, PayoutResponse } from './payment-response';
import { payoutLines } from './payouts';

type Tx = Prisma.TransactionClient;

const withJobs = {
  jobs: {
    orderBy: { id: 'asc' as const },
    include: { assignment: { select: { groupId: true, group: { select: { quantity: true, product: { select: { name: true } } } } } } },
  },
};
type PayoutWithJobs = Prisma.PayoutGetPayload<{ include: typeof withJobs }>;

/**
 * Paying partners (Payments spec): what is due, owed now less what payouts hold, in one transfer to the
 * partner's ready account. Worked out under the partner's lock, and a pending payout counts as paid,
 * so pressing Pay twice pays once. The transfer is made by a job after the commit, with the payout's
 * id as the idempotency key; a refused or reversed one gives its jobs back.
 */
@Injectable()
export class PayoutsService implements OnModuleInit {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly queue: QueueService,
    private readonly accounts: PaymentAccountService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
    private readonly partnerJobs: JobsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  onModuleInit(): void {
    // The connected account's event, and the platform's own for the same transfer.
    registerEventHandler('transfer.reversed', (tenantId, event) => this.reversed(tenantId, event));
  }

  /** A pending payout of everything due; 409 without a ready account or with nothing to pay. */
  async pay(auth: Pick<TenantAuth, 'tenantId' | 'userId'>, partnerId: string): Promise<PayoutResponse> {
    const payout = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      await lockPartner(tx, partnerId);
      const account = await tx.partnerPayoutAccount.findUnique({ where: { partnerId }, select: { state: true } });
      if (account?.state !== 'ready') throw new ConflictException('The partner has no ready payout account');
      const { lines, total } = payoutLines(await this.partnerJobs.dues(tx, partnerId));
      if (!total.gt(0)) throw new ConflictException('Nothing to pay');
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { defaultCurrency: true } });
      return tx.payout.create({
        data: {
          partnerId,
          amount: total,
          currency: tenant.defaultCurrency,
          status: 'pending',
          createdByUserId: auth.userId,
          jobs: { create: lines.map((line) => ({ assignmentId: line.assignmentId, amount: line.amount })) },
        },
        include: withJobs,
      });
    });
    await this.queue.enqueue('payments.payout.transfer', { tenantId: auth.tenantId, payoutId: payout.id });
    return toResponse(payout);
  }

  async list(tenantId: string, partnerId: string, query: PaginationQuery): Promise<PayoutPageResponse> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    return this.prisma.inTenant(tenantId, async (tx) => {
      // Row-level security hides other workspaces' partners, so a foreign id is simply not found.
      if (!(await tx.partner.findUnique({ where: { id: partnerId }, select: { id: true } }))) {
        throw new NotFoundException('Partner not found');
      }
      const rows = await tx.payout.findMany({
        where: { partnerId, ...(after ? { id: { lt: after.id } } : {}) },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
        include: withJobs,
      });
      const page = toPage(rows, query.limit, secret);
      return { data: page.data.map(toResponse), next_cursor: page.next_cursor };
    });
  }

  /**
   * The job: makes the transfer, then settles the payout under the partner's lock. A refusal fails it
   * for good, with the provider's message; any other error is retried with the same idempotency key.
   */
  async transfer(tenantId: string, payoutId: string): Promise<void> {
    const payout = await this.prisma.inTenant(tenantId, (tx) =>
      tx.payout.findUnique({ where: { id: payoutId }, include: { partner: { select: { name: true, payoutAccount: true } } } }),
    );
    if (!payout || payout.status !== 'pending') return;
    const destination = payout.partner.payoutAccount?.providerAccountId;
    let transferId: string;
    try {
      if (!destination) throw new ProviderRefusedError('The partner has no payout account');
      transferId = (
        await this.provider.transfer((await this.accounts.keysFor(tenantId)).keys, {
          destination,
          amount: payout.amount,
          currency: payout.currency,
          description: `Payout to ${payout.partner.name}`,
          idempotencyKey: payout.id,
        })
      ).id;
    } catch (error) {
      if (!(error instanceof ProviderRefusedError)) throw error;
      const failed = await this.settle(tenantId, payout.id, async (tx) => {
        await tx.payout.update({ where: { id: payout.id }, data: { status: 'failed', failure: error.message, settledAt: new Date() } });
      });
      if (failed) await this.tellFailed(tenantId, payout.id, error.message);
      return;
    }

    const paid = await this.settle(tenantId, payout.id, async (tx) => {
      await tx.payout.update({ where: { id: payout.id }, data: { status: 'paid', providerTransferId: transferId, settledAt: new Date() } });
      await this.ledger.post(tx, {
        ...buildJournal('payout', [
          { account: 'partner_costs', amount: payout.amount, partnerId: payout.partnerId },
          { account: 'stripe_balance', amount: payout.amount.neg() },
        ]),
        occurredAt: new Date(),
        currency: payout.currency,
        partnerId: payout.partnerId,
        payoutId: payout.id,
        providerObjectId: transferId,
        userId: payout.createdByUserId,
        memo: `Payout to ${payout.partner.name}`,
      });
    });
    if (!paid) return;
    await this.tell(tenantId, payout.id, () =>
      this.notifications.raise(tenantId, 'payout.paid', { type: 'payout', id: payout.id }, {
        amount: `${payout.amount.toFixed(2)} ${payout.currency}`,
        jobs: String(paid.jobs),
      }),
    );
  }

  /** The provider took back a transfer: the payout is reversed, its journal too, and its jobs are due again. */
  async reversed(tenantId: string, event: PaymentEvent): Promise<void> {
    const payout = await this.prisma.inTenant(tenantId, (tx) =>
      tx.payout.findFirst({ where: { providerTransferId: event.objectId }, select: { id: true, status: true } }),
    );
    if (!payout || payout.status !== 'paid') return;
    const reversed = await this.prisma.inTenant(tenantId, async (tx) => {
      const { partnerId } = await tx.payout.findUniqueOrThrow({ where: { id: payout.id }, select: { partnerId: true } });
      await lockPartner(tx, partnerId);
      const done = await tx.payout.updateMany({ where: { id: payout.id, status: 'paid' }, data: { status: 'reversed' } });
      if (done.count === 0) return false;
      const journal = await tx.ledgerJournal.findFirstOrThrow({ where: { kind: 'payout', payoutId: payout.id }, select: { id: true } });
      await this.ledger.reverse(tx, journal.id, 'The payment provider reversed the transfer');
      return true;
    });
    if (reversed) await this.tellFailed(tenantId, payout.id, 'The payment provider reversed the transfer.');
  }

  /** Mondays: one reminder per workspace of each partner with money due, and whether it can be paid. */
  async remind(): Promise<void> {
    const tenants = await this.prisma.tenant.findMany({ where: { status: 'active' }, select: { id: true } });
    for (const tenant of tenants) {
      try {
        const due = await this.prisma.inTenant(tenant.id, async (tx) => {
          const { defaultCurrency } = await tx.tenant.findUniqueOrThrow({ where: { id: tenant.id }, select: { defaultCurrency: true } });
          const partners = await tx.partner.findMany({
            where: { assignments: { some: { status: { in: ['accepted', 'replaced', 'cancelled'] } } } },
            orderBy: { name: 'asc' },
            select: { id: true, name: true, payoutAccount: { select: { state: true } } },
          });
          const lines: string[] = [];
          for (const partner of partners) {
            const { total } = payoutLines(await this.partnerJobs.dues(tx, partner.id));
            if (!total.gt(0)) continue;
            const payable = partner.payoutAccount?.state === 'ready' ? 'ready to pay' : 'no ready payout account';
            lines.push(`${partner.name}: ${total.toFixed(2)} ${defaultCurrency}, ${payable}`);
          }
          return lines;
        });
        if (due.length === 0) continue;
        await this.notifications.raise(tenant.id, 'payouts.reminder', { type: 'tenant', id: tenant.id }, { partners: due.join('\n') });
      } catch (error) {
        this.logger.error({ err: error, tenantId: tenant.id }, 'the payouts reminder failed');
      }
    }
  }

  /** Settles a pending payout under its partner's lock; null when it was settled already. */
  private async settle(tenantId: string, payoutId: string, apply: (tx: Tx) => Promise<void>): Promise<{ jobs: number } | null> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const { partnerId } = await tx.payout.findUniqueOrThrow({ where: { id: payoutId }, select: { partnerId: true } });
      await lockPartner(tx, partnerId);
      const current = await tx.payout.findUniqueOrThrow({ where: { id: payoutId }, select: { status: true, _count: { select: { jobs: true } } } });
      if (current.status !== 'pending') return null;
      await apply(tx);
      return { jobs: current._count.jobs };
    });
  }

  private async tellFailed(tenantId: string, payoutId: string, reason: string): Promise<void> {
    await this.tell(tenantId, payoutId, async () => {
      const payout = await this.prisma.inTenant(tenantId, (tx) =>
        tx.payout.findUniqueOrThrow({ where: { id: payoutId }, include: { partner: { select: { name: true } } } }),
      );
      await this.notifications.raise(tenantId, 'payout.failed', { type: 'payout', id: payoutId }, {
        partner_name: payout.partner.name,
        amount: `${payout.amount.toFixed(2)} ${payout.currency}`,
        reason,
      });
    });
  }

  /** After the commit: a failure to tell is logged; the payout stays as recorded. */
  private async tell(tenantId: string, payoutId: string, step: () => Promise<unknown>): Promise<void> {
    try {
      await step();
    } catch (error) {
      this.logger.error({ err: error, tenantId, payoutId }, 'a notification about a payout failed');
    }
  }
}

function toResponse(payout: PayoutWithJobs): PayoutResponse {
  return {
    id: payout.id,
    partner_id: payout.partnerId,
    amount: payout.amount.toFixed(2),
    currency: payout.currency,
    status: payout.status as PayoutResponse['status'],
    failure: payout.failure,
    created_at: payout.createdAt.toISOString(),
    settled_at: payout.settledAt?.toISOString() ?? null,
    jobs: payout.jobs.map((job) => ({
      assignment_id: job.assignmentId,
      group_id: job.assignment.groupId,
      product: job.assignment.group.product ? { name: job.assignment.group.product.name } : null,
      quantity: job.assignment.group.quantity,
      amount: job.amount.toFixed(2),
    })),
  };
}
