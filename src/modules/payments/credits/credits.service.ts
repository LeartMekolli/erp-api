import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { newId } from '../../../common/ids/uuid';
import { decodeCursor } from '../../../common/pagination/cursor';
import { toPage } from '../../../common/pagination/page';
import type { Page } from '../../../common/pagination/page';
import { ConfigService } from '../../../config/config.service';
import { PrismaService } from '../../../database/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../audit/audit.service';
import { lockCustomer } from '../../customers/customers.service';
import type { TenantAuth } from '../../identity/auth-context';
import { localDate, startOfLocalDay } from '../../orders/dates';
import { GRANT_SOURCES, inSpendingOrder, takeFrom } from './credit-ledger';
import type { CreditEntryKind, GrantSource, Spendable } from './credit-ledger';
import type { CreditBalanceResponse, CreditEntryResponse, CreditHistoryQuery, GrantCredits } from './credit-response';

const DAY_MS = 86_400_000;

export interface GrantInput {
  customerId: string;
  source: GrantSource;
  amount: number;
  expiresAt: Date;
  sourceKey: string;
  campaignId?: string;
  packPurchaseId?: string;
  userId?: string;
  reason?: string;
}

/**
 * The credit ledger (Payments 2 spec, D48, D49): grants, spends, give-backs and expiries as
 * insert-only rows. A grant's remaining credits are the sum of its entries; a balance is never
 * stored. Every write holds the customer's row lock, so two spends can't both take the last credits.
 */
@Injectable()
export class CreditsService {
  private readonly logger = new Logger(CreditsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  /** The caller holds the customer's lock. The same source key again returns the grant it wrote. */
  async grant(tx: Prisma.TransactionClient, input: GrantInput): Promise<{ grantId: string; created: boolean }> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) throw new Error(`A grant is a whole number above 0, not ${input.amount}`);
    const existing = await tx.creditGrant.findFirst({ where: { sourceKey: input.sourceKey }, select: { id: true, customerId: true } });
    if (existing) {
      if (existing.customerId !== input.customerId) throw new Error(`Source key ${input.sourceKey} belongs to another customer`);
      return { grantId: existing.id, created: false };
    }
    const grant = await tx.creditGrant.create({
      data: {
        customerId: input.customerId,
        source: input.source,
        amount: input.amount,
        expiresAt: input.expiresAt,
        sourceKey: input.sourceKey,
        campaignId: input.campaignId,
        packPurchaseId: input.packPurchaseId,
        createdByUserId: input.userId,
        reason: input.reason,
      },
    });
    await tx.creditEntry.create({
      data: { customerId: input.customerId, grantId: grant.id, kind: 'grant', amount: input.amount, occurredAt: grant.grantedAt },
    });
    return { grantId: grant.id, created: true };
  }

  /**
   * Takes `amount` credits in the spending order from grants usable now. The same reference again
   * returns the same spend. Not enough usable credits: a 409, and nothing is written.
   */
  async spend(tenantId: string, customerId: string, input: { amount: number; reason: string; reference: string }): Promise<{ spendId: string }> {
    return this.prisma.inTenant(tenantId, (tx) => this.spendIn(tx, customerId, input));
  }

  /** `spend` on the caller's transaction, which takes the customer's lock here unless it holds it. */
  async spendIn(
    tx: Prisma.TransactionClient,
    customerId: string,
    input: { amount: number; reason: string; reference: string },
  ): Promise<{ spendId: string }> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) throw new Error(`A spend is a whole number above 0, not ${input.amount}`);
    await lockCustomer(tx, customerId);
    const existing = await tx.creditSpend.findFirst({ where: { customerId, reference: input.reference }, select: { id: true } });
    if (existing) return { spendId: existing.id };

    const now = new Date();
    const parts = takeFrom(await this.usable(tx, customerId, now), input.amount);
    if (!parts) throw new ConflictException('Not enough credits');
    const spend = await tx.creditSpend.create({
      data: { customerId, kind: 'spend', amount: input.amount, reason: input.reason, reference: input.reference, occurredAt: now },
    });
    await tx.creditEntry.createMany({
      data: parts.map((part) => ({ customerId, grantId: part.grantId, spendId: spend.id, kind: 'spend', amount: -part.amount, occurredAt: now })),
    });
    return { spendId: spend.id };
  }

  /**
   * Returns every credit of a spend to the grants it came from, once; a second call does nothing.
   * Credits returned to a grant that has expired since are written off by the next expiry run.
   */
  async giveBack(tenantId: string, spendId: string): Promise<void> {
    await this.prisma.inTenant(tenantId, async (tx) => {
      const spend = await tx.creditSpend.findFirst({ where: { id: spendId, kind: 'spend' } });
      if (!spend) throw new NotFoundException('Spend not found');
      await lockCustomer(tx, spend.customerId);
      if (await tx.creditSpend.findFirst({ where: { givesBackId: spendId }, select: { id: true } })) return;

      const now = new Date();
      const taken = await tx.creditEntry.findMany({ where: { spendId, kind: 'spend' }, orderBy: { id: 'asc' } });
      const back = await tx.creditSpend.create({
        data: { customerId: spend.customerId, kind: 'give_back', amount: spend.amount, reason: spend.reason, givesBackId: spendId, occurredAt: now },
      });
      await tx.creditEntry.createMany({
        data: taken.map((entry) => ({
          customerId: spend.customerId,
          grantId: entry.grantId,
          spendId: back.id,
          kind: 'give_back',
          amount: -entry.amount,
          occurredAt: now,
        })),
      });
    });
  }

  /**
   * The caller holds the customer's lock. Writes off what is left of each of the customer's grants
   * that expired by `at`, optionally only some of them. Returns the credits written off.
   */
  async expire(
    tx: Prisma.TransactionClient,
    customerId: string,
    at: Date,
    filter: { source?: GrantSource; grantIds?: string[] } = {},
  ): Promise<number> {
    const grants = await tx.creditGrant.findMany({
      where: {
        customerId,
        expiresAt: { lte: at },
        source: filter.source,
        ...(filter.grantIds ? { id: { in: filter.grantIds } } : {}),
      },
      select: { id: true },
    });
    const remaining = await this.remaining(tx, grants.map((grant) => grant.id));
    const left = grants.map((grant) => ({ grantId: grant.id, amount: remaining.get(grant.id) ?? 0 })).filter((grant) => grant.amount > 0);
    if (left.length === 0) return 0;
    const now = new Date();
    await tx.creditEntry.createMany({
      data: left.map((grant) => ({ customerId, grantId: grant.grantId, kind: 'expire', amount: -grant.amount, occurredAt: now })),
    });
    return left.reduce((sum, grant) => sum + grant.amount, 0);
  }

  /**
   * The caller holds the customer's lock. Ends early what is left of every grant of `source` still in
   * date, as when a plan change replaces the monthly allowance; the expiry job takes the rest. Returns
   * the credits written off.
   */
  async writeOff(tx: Prisma.TransactionClient, customerId: string, source: GrantSource): Promise<number> {
    const grants = await tx.creditGrant.findMany({ where: { customerId, source, expiresAt: { gt: new Date() } }, select: { id: true } });
    return this.expire(tx, customerId, new Date(8.64e15), { grantIds: grants.map((grant) => grant.id) });
  }

  /** The credits usable at `at`: grants not expired yet with credits left, in the spending order. */
  async balance(tx: Prisma.TransactionClient, customerId: string, at: Date): Promise<CreditBalanceResponse> {
    const grants = inSpendingOrder(await this.usable(tx, customerId, at));
    const by_source = Object.fromEntries(GRANT_SOURCES.map((source) => [source, 0])) as Record<GrantSource, number>;
    for (const grant of grants) by_source[grant.source] += grant.remaining;
    return {
      total: grants.reduce((sum, grant) => sum + grant.remaining, 0),
      by_source,
      grants: grants.map((grant) => ({
        id: grant.id,
        source: grant.source,
        remaining: grant.remaining,
        expires_at: grant.expiresAt.toISOString(),
      })),
    };
  }

  /** The balance, for a customer that must exist. */
  async balanceOf(tenantId: string, customerId: string): Promise<CreditBalanceResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      await this.mustExist(tx, customerId);
      return this.balance(tx, customerId, new Date());
    });
  }

  /** Every movement of the customer's credits, newest first. */
  async history(tenantId: string, customerId: string, query: CreditHistoryQuery): Promise<Page<CreditEntryResponse>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    return this.prisma.inTenant(tenantId, async (tx) => {
      await this.mustExist(tx, customerId);
      const rows = await tx.creditEntry.findMany({
        where: { customerId, ...(after ? { id: { lt: after.id } } : {}) },
        include: { grant: { select: { source: true, reason: true } }, spend: { select: { reason: true } } },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      });
      const page = toPage(rows, query.limit, secret);
      return {
        data: page.data.map((row) => ({
          id: row.id,
          kind: row.kind as CreditEntryKind,
          amount: row.amount,
          source: row.grant.source as GrantSource,
          reason: row.kind === 'grant' ? row.grant.reason : (row.spend?.reason ?? null),
          occurred_at: row.occurredAt.toISOString(),
        })),
        next_cursor: page.next_cursor,
      };
    });
  }

  /** Credits staff give by hand, usable to the end of `expires_on` in the workspace's time zone; audited. */
  async grantByStaff(auth: TenantAuth, customerId: string, input: GrantCredits): Promise<CreditBalanceResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await lockCustomer(tx, customerId);
      const { timezone } = await tx.tenant.findFirstOrThrow({ select: { timezone: true } });
      const now = new Date();
      if (input.expires_on < localDate(now, timezone)) throw new BadRequestException('expires_on: must be today or later');
      const dayAfter = new Date(new Date(`${input.expires_on}T00:00:00Z`).getTime() + DAY_MS).toISOString().slice(0, 10);

      const { grantId } = await this.grant(tx, {
        customerId,
        source: 'staff',
        amount: input.amount,
        expiresAt: startOfLocalDay(dayAfter, timezone),
        sourceKey: `staff:${newId()}`,
        userId: auth.userId,
        reason: input.reason,
      });
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'credits.granted',
        subject: { type: 'customer', id: customerId },
        after: { grant_id: grantId, amount: input.amount, expires_on: input.expires_on, reason: input.reason },
      });
      return this.balance(tx, customerId, now);
    });
  }

  /**
   * Scheduled (`payments.credits.expire`): writes off what is left of every expired grant, customer
   * by customer under its lock. Safe to run again: a grant with nothing left is skipped.
   */
  async expireDue(): Promise<void> {
    const tenants = await this.prisma.tenant.findMany({ select: { id: true } });
    for (const tenant of tenants) {
      const now = new Date();
      const customers = await this.prisma.inTenant(tenant.id, (tx) =>
        tx.$queryRaw<{ customer_id: string }[]>`
          SELECT DISTINCT left_over.customer_id
          FROM (
            SELECT g.customer_id
            FROM credit_grant g
            JOIN credit_entry e ON e.grant_id = g.id
            WHERE g.expires_at <= ${now}
            GROUP BY g.id, g.customer_id
            HAVING SUM(e.amount) > 0
          ) AS left_over`,
      );
      for (const { customer_id: customerId } of customers) {
        // One customer failing must not keep the others' credits from expiring.
        try {
          await this.prisma.inTenant(tenant.id, async (tx) => {
            await lockCustomer(tx, customerId);
            await this.expire(tx, customerId, now);
          });
        } catch (error) {
          this.logger.error({ err: error, tenantId: tenant.id, customerId }, 'expiring credits failed');
        }
      }
    }
  }

  /** Grants not expired at `at` with credits left. */
  private async usable(tx: Prisma.TransactionClient, customerId: string, at: Date): Promise<Spendable[]> {
    const grants = await tx.creditGrant.findMany({
      where: { customerId, expiresAt: { gt: at } },
      select: { id: true, source: true, grantedAt: true, expiresAt: true },
    });
    const remaining = await this.remaining(tx, grants.map((grant) => grant.id));
    return grants
      .map((grant) => ({ ...grant, source: grant.source as GrantSource, remaining: remaining.get(grant.id) ?? 0 }))
      .filter((grant) => grant.remaining > 0);
  }

  /** What is left of each grant: the sum of its entries. */
  private async remaining(tx: Prisma.TransactionClient, grantIds: string[]): Promise<Map<string, number>> {
    if (grantIds.length === 0) return new Map();
    const sums = await tx.creditEntry.groupBy({ by: ['grantId'], where: { grantId: { in: grantIds } }, _sum: { amount: true } });
    return new Map(sums.map((sum) => [sum.grantId, sum._sum.amount ?? 0]));
  }

  private async mustExist(tx: Prisma.TransactionClient, customerId: string): Promise<void> {
    if (!(await tx.customer.findFirst({ where: { id: customerId }, select: { id: true } }))) {
      throw new NotFoundException('Customer not found');
    }
  }
}
