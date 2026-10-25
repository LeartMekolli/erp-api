import { ConflictException, ForbiddenException, Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma, Quote } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { CustomerAuth } from '../identity/auth-context';
import { NotificationsService } from '../notifications/notifications.service';
import { QuotesService } from '../pricing/quotes.service';
import type { CustomerQuoteRequest, PartnerChoice, QuotedJob, QuoteContext } from '../pricing/quotes.service';
import type { QuoteResultResponse } from '../pricing/quote-response';
import { WorkOrdersService } from '../workflow/work-orders.service';
import { EligibilityService } from './eligibility.service';
import { jobLabel, toAssignment } from './jobs.service';
import type { PartnerChoicesResponse } from './partner-response';
import { lockPartner } from './partners.service';
import { ScoreService } from './score.service';

type Tx = Prisma.TransactionClient;

/**
 * Customers picking a workshop (Partners spec, goals 11 and 12; B2): the workshops that take direct
 * orders and can take the job, each at the price the customer pays with it, and the job handed to the
 * picked one as soon as it starts, unless it can no longer take it.
 */
@Injectable()
export class PartnerQuotesService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quotes: QuotesService,
    private readonly eligibility: EligibilityService,
    private readonly workOrders: WorkOrdersService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly score: ScoreService,
  ) {}

  onModuleInit(): void {
    this.workOrders.registerStartHook((tx, started) => this.startDirect(tx, started));
  }

  /** The workshops the customer may pick for the configuration, by name, each priced as a quote with it. */
  async choices(auth: CustomerAuth, body: CustomerQuoteRequest): Promise<PartnerChoicesResponse> {
    await this.mayPick(auth);
    const { partners, scores } = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const rows = await tx.partner.findMany({
        where: { status: 'approved', acceptsDirectOrders: true },
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        select: { id: true, displayName: true },
      });
      return { partners: rows, scores: await this.score.scores(tx, rows.map((row) => row.id)) };
    });
    const data: PartnerChoicesResponse['data'] = [];
    for (const partner of partners) {
      const priced = await this.quotes.preview(auth, body, this.context(auth), this.choice(partner.id));
      if (priced.accepted) {
        // Only the overall score: never its parts (Global Constraints).
        const score = scores.get(partner.id)!.overall;
        data.push({ partner: { id: partner.id, display_name: partner.displayName }, score, price: priced.price });
      }
    }
    return { data };
  }

  /** A quote with the picked workshop's prices on its steps, refused with `partner_unavailable` when it can't take the job. */
  async quote(auth: CustomerAuth, body: CustomerQuoteRequest, partnerId: string): Promise<QuoteResultResponse> {
    await this.mayPick(auth);
    return this.quotes.create(auth, body, this.context(auth), this.choice(partnerId));
  }

  /** The workshop takes direct orders and can take the job as quoted. An unknown one simply can't. */
  private choice(partnerId: string): PartnerChoice {
    return {
      partnerId,
      admits: async (tx: Tx, job: QuotedJob) => {
        const partner = await tx.partner.findUnique({ where: { id: partnerId }, select: { acceptsDirectOrders: true } });
        if (!partner?.acceptsDirectOrders) return false;
        const { facts } = await this.eligibility.quotedJob(tx, job);
        return (await this.eligibility.judgeFacts(tx, facts, [partnerId], null)).get(partnerId)!.ok;
      },
    };
  }

  /**
   * When a quote with a picked workshop starts: the workshop is judged again under its row lock, and
   * the job is its own at once at the quoted cost; if it can no longer take it, nothing starts and the
   * customer picks again (Review Focus 5).
   */
  private async startDirect(
    tx: Tx,
    started: { groupId: string; quote: Quote; userId: string; tenantId: string },
  ): Promise<(() => Promise<void>) | undefined> {
    const { quote, groupId } = started;
    if (!quote.partnerId || !quote.partnerCost) return undefined;
    await lockPartner(tx, quote.partnerId);
    const partner = await tx.partner.findUniqueOrThrow({ where: { id: quote.partnerId }, select: { acceptsDirectOrders: true } });
    const job = await this.eligibility.job(tx, groupId);
    const verdict = (await this.eligibility.judgeFacts(tx, job.facts, [quote.partnerId], groupId)).get(quote.partnerId)!;
    const reasons = [...(partner.acceptsDirectOrders ? [] : ['Does not take direct orders']), ...(verdict.ok ? [] : verdict.reasons)];
    if (reasons.length > 0) {
      throw new ConflictException({
        message: 'The workshop the customer picked can no longer take this job; the customer needs to pick again',
        errors: reasons.map((reason) => ({ path: 'quote_id', message: reason })),
      });
    }

    const row = await tx.jobAssignment.create({
      data: {
        groupId,
        partnerId: quote.partnerId,
        kind: 'direct',
        status: 'accepted',
        cost: quote.partnerCost,
        createdByUserId: started.userId,
      },
      include: { partner: { select: { id: true, name: true } } },
    });
    await this.audit.record(tx, {
      actor: { type: 'user', id: started.userId },
      action: 'partner.job',
      subject: { type: 'job_assignment', id: row.id },
      after: toAssignment(row),
    });
    const label = await jobLabel(tx, groupId);
    return async () => {
      await this.notifications.raise(started.tenantId, 'partner.job.direct', { type: 'job_assignment', id: row.id }, {
        product_name: label.productName,
        quantity: String(label.quantity),
      });
    };
  }

  private context(auth: CustomerAuth): QuoteContext {
    return { customerId: auth.customerId, audience: 'customer' };
  }

  /** Only customers the workspace lets pick. */
  private async mayPick(auth: CustomerAuth): Promise<void> {
    const customer = await this.prisma.inTenant(auth.tenantId, (tx) =>
      tx.customer.findUniqueOrThrow({ where: { id: auth.customerId }, select: { mayPickPartner: true } }),
    );
    if (!customer.mayPickPartner) {
      throw new ForbiddenException('The workspace has not let this customer pick a workshop');
    }
  }
}
