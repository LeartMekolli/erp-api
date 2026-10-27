import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { decodeCursor } from '../../common/pagination/cursor';
import { toPage } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { Account, JournalDraft } from './ledger';
import type { LedgerJournalResponse, LedgerQuery } from './payment-response';

export interface PostJournal extends JournalDraft {
  occurredAt: Date;
  currency: string;
  orderId?: string;
  customerId?: string;
  partnerId?: string;
  payoutId?: string;
  refundId?: string;
  /** The provider's id for the fact being recorded. The same `(kind, providerObjectId)` posts once. */
  providerObjectId?: string;
  userId?: string;
  memo?: string;
}

const withLines = { lines: { orderBy: { id: 'asc' as const } } };

/** The double-entry ledger (Payments spec): append-only journals that always balance. */
@Injectable()
export class LedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Posts a journal in the caller's transaction. A repeat for the same provider fact is a no-op. */
  async post(tx: Prisma.TransactionClient, input: PostJournal): Promise<{ journalId: string; created: boolean }> {
    if (input.providerObjectId) {
      await this.lock(tx, `${input.kind}:${input.providerObjectId}`);
      const existing = await tx.ledgerJournal.findFirst({
        where: { kind: input.kind, providerObjectId: input.providerObjectId },
        select: { id: true },
      });
      if (existing) return { journalId: existing.id, created: false };
    }
    const journal = await tx.ledgerJournal.create({
      data: {
        kind: input.kind,
        occurredAt: input.occurredAt,
        currency: input.currency,
        orderId: input.orderId,
        customerId: input.customerId,
        partnerId: input.partnerId,
        payoutId: input.payoutId,
        refundId: input.refundId,
        providerObjectId: input.providerObjectId,
        createdByUserId: input.userId,
        memo: input.memo ?? '',
        lines: {
          create: input.entries.map((entry) => ({
            account: entry.account,
            amount: entry.amount,
            customerId: entry.customerId,
            partnerId: entry.partnerId,
          })),
        },
      },
      select: { id: true },
    });
    return { journalId: journal.id, created: true };
  }

  /** Posts the negated lines of a journal, once. A second reversal is a 409. */
  async reverse(
    tx: Prisma.TransactionClient,
    journalId: string,
    memo: string,
    userId?: string,
  ): Promise<{ journalId: string; created: boolean }> {
    await this.lock(tx, `reverse:${journalId}`);
    const original = await tx.ledgerJournal.findFirst({ where: { id: journalId }, include: withLines });
    if (!original) throw new NotFoundException('Journal not found');
    if (original.kind === 'reversal') throw new ConflictException('A reversal cannot be reversed');
    if (await tx.ledgerJournal.findFirst({ where: { reversesJournalId: journalId }, select: { id: true } })) {
      throw new ConflictException('This journal has already been reversed');
    }
    const reversal = await tx.ledgerJournal.create({
      data: {
        kind: 'reversal',
        occurredAt: new Date(),
        currency: original.currency,
        orderId: original.orderId,
        customerId: original.customerId,
        partnerId: original.partnerId,
        payoutId: original.payoutId,
        refundId: original.refundId,
        reversesJournalId: journalId,
        createdByUserId: userId,
        memo,
        lines: {
          create: original.lines.map((line) => ({
            account: line.account,
            amount: line.amount.neg(),
            customerId: line.customerId,
            partnerId: line.partnerId,
          })),
        },
      },
      select: { id: true },
    });
    return { journalId: reversal.id, created: true };
  }

  /** What an account holds for a customer, a partner or an order: debits minus credits. */
  async balance(
    tx: Prisma.TransactionClient,
    account: Account,
    filter: { customerId?: string; partnerId?: string; orderId?: string },
  ): Promise<Prisma.Decimal> {
    const total = await tx.ledgerLine.aggregate({
      _sum: { amount: true },
      where: {
        account,
        customerId: filter.customerId,
        partnerId: filter.partnerId,
        ...(filter.orderId ? { journal: { orderId: filter.orderId } } : {}),
      },
    });
    return total._sum.amount ?? new Prisma.Decimal(0);
  }

  async list(tenantId: string, query: LedgerQuery): Promise<Page<LedgerJournalResponse>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    return this.prisma.inTenant(tenantId, async (tx) => {
      const rows = await tx.ledgerJournal.findMany({
        where: {
          ...(after ? { id: { lt: after.id } } : {}),
          orderId: query.order_id,
          customerId: query.customer_id,
          partnerId: query.partner_id,
          ...(query.from || query.to
            ? {
                occurredAt: {
                  ...(query.from ? { gte: new Date(`${query.from}T00:00:00Z`) } : {}),
                  // `to` is a whole day, so the day itself is included.
                  ...(query.to ? { lt: new Date(new Date(`${query.to}T00:00:00Z`).getTime() + 86_400_000) } : {}),
                },
              }
            : {}),
        },
        include: withLines,
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      });
      const page = toPage(rows, query.limit, secret);
      return { data: page.data.map(toResponse), next_cursor: page.next_cursor };
    });
  }

  /** Serialises two writers of the same provider fact or the same reversal within the workspace. */
  private async lock(tx: Prisma.TransactionClient, key: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(current_setting('app.current_tenant_id') || ':' || ${key}, 0))`;
  }
}

type JournalRow = Prisma.LedgerJournalGetPayload<{ include: typeof withLines }>;

function toResponse(row: JournalRow): LedgerJournalResponse {
  return {
    id: row.id,
    kind: row.kind as LedgerJournalResponse['kind'],
    occurred_at: row.occurredAt.toISOString(),
    currency: row.currency,
    order_id: row.orderId,
    customer_id: row.customerId,
    partner_id: row.partnerId,
    payout_id: row.payoutId,
    refund_id: row.refundId,
    provider_object_id: row.providerObjectId,
    reverses_journal_id: row.reversesJournalId,
    memo: row.memo,
    lines: row.lines.map((line) => ({
      account: line.account as LedgerJournalResponse['lines'][number]['account'],
      amount: line.amount.toFixed(2),
      customer_id: line.customerId,
      partner_id: line.partnerId,
    })),
  };
}
