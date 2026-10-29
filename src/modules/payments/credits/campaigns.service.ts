import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import type { CreditCampaign, CreditCampaignTarget, Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../audit/audit.service';
import { lockCustomer } from '../../customers/customers.service';
import type { TenantAuth } from '../../identity/auth-context';
import { NotificationsService } from '../../notifications/notifications.service';
import { PLAN_GIVING_STATUSES, planOf } from '../plans/plan-of';
import { SubscriptionsService } from '../plans/subscriptions.service';
import { campaignProblem } from './credit-response';
import type { CampaignListResponse, CampaignResponse, CampaignStatus, CreateCampaign, UpdateCampaign } from './credit-response';
import { CreditsService } from './credits.service';

const DAY_MS = 86_400_000;

type CampaignRow = CreditCampaign & { targets: CreditCampaignTarget[] };

/** What happened when a customer asked a campaign for its credits, to tell after commit. */
type Outcome =
  | { kind: 'granted'; customerId: string; credits: number; expiresAt: Date }
  | { kind: 'budget_used'; campaignId: string; name: string; budget: number }
  | null;

/**
 * Campaigns (Payments 2 spec, goal 11): free credits given automatically, once per customer, to the
 * customers on targeted plans and those named, while the campaign runs and its budget holds. Every
 * grant locks the customer, then the campaign, so two grants at once can't overspend the budget.
 */
@Injectable()
export class CampaignsService implements OnModuleInit {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly credits: CreditsService,
    private readonly notifications: NotificationsService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  onModuleInit(): void {
    // A customer who joins a targeted plan while a campaign runs gets its credits then.
    this.subscriptions.afterPlanChange((tenantId, customerId) => this.grantFor(tenantId, customerId));
  }

  async list(tenantId: string): Promise<CampaignListResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const rows = await tx.creditCampaign.findMany({ include: { targets: true }, orderBy: { id: 'desc' } });
      return { data: await Promise.all(rows.map((row) => this.view(tx, row))) };
    });
  }

  async get(tenantId: string, id: string): Promise<CampaignResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const row = await tx.creditCampaign.findFirst({ where: { id }, include: { targets: true } });
      if (!row) throw new NotFoundException('Campaign not found');
      return this.view(tx, row);
    });
  }

  async create(auth: TenantAuth, input: CreateCampaign): Promise<CampaignResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await this.checkTargets(tx, input.targets);
      const row = await tx.creditCampaign.create({
        data: {
          name: input.name,
          creditsPerCustomer: input.credits_per_customer,
          creditDays: input.credit_days,
          startsAt: new Date(input.starts_at),
          endsAt: new Date(input.ends_at),
          budget: input.budget,
          createdByUserId: auth.userId,
        },
      });
      await this.replaceTargets(tx, row.id, input.targets);
      const after = await this.view(tx, await this.load(tx, row.id));
      await this.record(tx, auth, row.id, undefined, after);
      return after;
    });
  }

  /** Only a draft or a paused campaign changes: a running one would grant by two sets of rules. */
  async update(auth: TenantAuth, id: string, patch: UpdateCampaign): Promise<CampaignResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const current = await this.lock(tx, id);
      if (current.status !== 'draft' && current.status !== 'paused') {
        throw new ConflictException('Only a draft or a paused campaign can be changed; pause it first');
      }
      const before = await this.view(tx, current);
      const merged = {
        credits_per_customer: patch.credits_per_customer ?? current.creditsPerCustomer,
        starts_at: patch.starts_at ?? current.startsAt,
        ends_at: patch.ends_at ?? current.endsAt,
        budget: patch.budget ?? current.budget,
        targets: patch.targets ?? before.targets,
      };
      const problem = campaignProblem(merged);
      if (problem) throw new BadRequestException(problem);
      if (patch.targets) await this.checkTargets(tx, patch.targets);
      await tx.creditCampaign.update({
        where: { id },
        data: {
          name: patch.name,
          creditsPerCustomer: patch.credits_per_customer,
          creditDays: patch.credit_days,
          startsAt: patch.starts_at === undefined ? undefined : new Date(patch.starts_at),
          endsAt: patch.ends_at === undefined ? undefined : new Date(patch.ends_at),
          budget: patch.budget,
          // More room: a customer who finds none again is told of again.
          budgetUsedAt: patch.budget !== undefined && patch.budget > current.budget ? null : undefined,
        },
      });
      if (patch.targets) await this.replaceTargets(tx, id, patch.targets);
      const after = await this.view(tx, await this.load(tx, id));
      await this.record(tx, auth, id, before, after);
      return after;
    });
  }

  /** Starts or resumes granting, and grants to everyone it targets now. An ended campaign is final. */
  async activate(auth: TenantAuth, id: string): Promise<CampaignResponse> {
    await this.move(auth, id, 'active', ['draft', 'paused', 'active']);
    await this.run(auth.tenantId);
    return this.get(auth.tenantId, id);
  }

  /** Stops new grants for now; what was given stays until it expires. */
  pause(auth: TenantAuth, id: string): Promise<CampaignResponse> {
    return this.move(auth, id, 'paused', ['active', 'paused']);
  }

  /** Stops new grants for good; what was given stays until it expires. */
  end(auth: TenantAuth, id: string): Promise<CampaignResponse> {
    return this.move(auth, id, 'ended', ['draft', 'active', 'paused']);
  }

  /**
   * Grants the customer every running campaign it is targeted by and hasn't had yet, each in its own
   * transaction: the customer locked, then the campaign. A campaign whose budget no longer holds the
   * customer's credits tells staff once.
   */
  async grantFor(tenantId: string, customerId: string): Promise<void> {
    const candidates = await this.prisma.inTenant(tenantId, async (tx) => {
      const plan = await planOf(tx, customerId);
      const now = new Date();
      const running = await tx.creditCampaign.findMany({
        where: {
          status: 'active',
          startsAt: { lte: now },
          endsAt: { gt: now },
          targets: { some: { OR: [{ planId: plan.id }, { customerId }] } },
        },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      const had = await tx.creditGrant.findMany({
        where: { customerId, campaignId: { in: running.map((campaign) => campaign.id) } },
        select: { campaignId: true },
      });
      const given = new Set(had.map((grant) => grant.campaignId));
      return running.map((campaign) => campaign.id).filter((id) => !given.has(id));
    });

    for (const campaignId of candidates) {
      const outcome = await this.prisma.inTenant(tenantId, (tx) => this.grantOne(tx, campaignId, customerId));
      await this.tell(tenantId, outcome);
    }
  }

  /** Every customer a running campaign of the workspace targets (`payments.campaigns.grant`, and on activation). */
  async run(tenantId: string): Promise<void> {
    const customers = await this.prisma.inTenant(tenantId, async (tx) => {
      const now = new Date();
      const targets = await tx.creditCampaignTarget.findMany({
        where: { campaign: { status: 'active', startsAt: { lte: now }, endsAt: { gt: now } } },
        select: { planId: true, customerId: true },
      });
      if (targets.length === 0) return [];
      const planIds = targets.flatMap((target) => (target.planId ? [target.planId] : []));
      const named = targets.flatMap((target) => (target.customerId ? [target.customerId] : []));
      const free = await tx.plan.findFirstOrThrow({ where: { isDefault: true }, select: { id: true } });
      const giving = [...PLAN_GIVING_STATUSES];
      const rows = await tx.customer.findMany({
        where: {
          status: 'active',
          OR: [
            { id: { in: named } },
            { subscription: { is: { status: { in: giving }, planPrice: { planId: { in: planIds } } } } },
            // The free plan's customers are those without a subscription that gives a plan.
            ...(planIds.includes(free.id)
              ? [{ subscription: { is: null } }, { subscription: { is: { status: { notIn: giving } } } }]
              : []),
          ],
        },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      return rows.map((row) => row.id);
    });
    for (const customerId of customers) {
      // One customer failing must not keep the others' credits back.
      try {
        await this.grantFor(tenantId, customerId);
      } catch (error) {
        this.logger.error({ err: error, tenantId, customerId }, 'granting campaign credits failed');
      }
    }
  }

  /** The scheduled job: every active workspace with a running campaign. */
  async runEverywhere(): Promise<void> {
    const tenants = await this.prisma.tenant.findMany({ where: { status: 'active' }, select: { id: true } });
    for (const tenant of tenants) {
      try {
        await this.run(tenant.id);
      } catch (error) {
        this.logger.error({ err: error, tenantId: tenant.id }, 'running campaigns failed');
      }
    }
  }

  private async grantOne(tx: Prisma.TransactionClient, campaignId: string, customerId: string): Promise<Outcome> {
    await lockCustomer(tx, customerId);
    const campaign = await this.lock(tx, campaignId);
    const now = new Date();
    if (campaign.status !== 'active' || campaign.startsAt > now || campaign.endsAt <= now) return null;
    const sourceKey = `campaign:${campaignId}:${customerId}`;
    if (await tx.creditGrant.findFirst({ where: { sourceKey }, select: { id: true } })) return null;

    const granted = (await tx.creditGrant.aggregate({ where: { campaignId }, _sum: { amount: true } }))._sum.amount ?? 0;
    if (campaign.budget - granted < campaign.creditsPerCustomer) {
      if (campaign.budgetUsedAt) return null;
      await tx.creditCampaign.update({ where: { id: campaignId }, data: { budgetUsedAt: now } });
      return { kind: 'budget_used', campaignId, name: campaign.name, budget: campaign.budget };
    }
    const expiresAt = new Date(now.getTime() + campaign.creditDays * DAY_MS);
    await this.credits.grant(tx, { customerId, source: 'campaign', amount: campaign.creditsPerCustomer, expiresAt, sourceKey, campaignId });
    return { kind: 'granted', customerId, credits: campaign.creditsPerCustomer, expiresAt };
  }

  private async tell(tenantId: string, outcome: Outcome): Promise<void> {
    if (!outcome) return;
    try {
      if (outcome.kind === 'granted') {
        await this.notifications.raise(tenantId, 'credits.added', { type: 'customer', id: outcome.customerId }, {
          credits: String(outcome.credits),
          source: 'campaign',
          expires_on: outcome.expiresAt.toISOString().slice(0, 10),
        });
      } else {
        await this.notifications.raise(tenantId, 'campaign.budget_used', { type: 'credit_campaign', id: outcome.campaignId }, {
          campaign: outcome.name,
          budget: String(outcome.budget),
        });
      }
    } catch (error) {
      this.logger.error({ err: error, tenantId }, 'a notice about a campaign failed');
    }
  }

  private async move(auth: TenantAuth, id: string, to: CampaignStatus, from: CampaignStatus[]): Promise<CampaignResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const current = await this.lock(tx, id);
      if (!from.includes(current.status as CampaignStatus)) throw new ConflictException(`A campaign that is ${current.status} can't be ${to}`);
      const before = await this.view(tx, current);
      await tx.creditCampaign.update({ where: { id }, data: { status: to } });
      const after = await this.view(tx, await this.load(tx, id));
      if (current.status !== to) await this.record(tx, auth, id, before, after);
      return after;
    });
  }

  /** Row-level security hides other workspaces' campaigns, so a foreign id is simply not found. */
  private async lock(tx: Prisma.TransactionClient, id: string): Promise<CampaignRow> {
    await tx.$queryRaw`SELECT id FROM credit_campaign WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await tx.creditCampaign.findFirst({ where: { id }, include: { targets: true } });
    if (!row) throw new NotFoundException('Campaign not found');
    return row;
  }

  private load(tx: Prisma.TransactionClient, id: string): Promise<CampaignRow> {
    return tx.creditCampaign.findUniqueOrThrow({ where: { id }, include: { targets: true } });
  }

  private async checkTargets(tx: Prisma.TransactionClient, targets: { plan_ids: string[]; customer_ids: string[] }): Promise<void> {
    const plans = await tx.plan.count({ where: { id: { in: targets.plan_ids } } });
    if (plans !== new Set(targets.plan_ids).size) throw new BadRequestException('targets: a plan is not of this workspace');
    const customers = await tx.customer.count({ where: { id: { in: targets.customer_ids } } });
    if (customers !== new Set(targets.customer_ids).size) throw new BadRequestException('targets: a customer is not of this workspace');
  }

  private async replaceTargets(tx: Prisma.TransactionClient, campaignId: string, targets: { plan_ids: string[]; customer_ids: string[] }): Promise<void> {
    await tx.creditCampaignTarget.deleteMany({ where: { campaignId } });
    await tx.creditCampaignTarget.createMany({
      data: [
        ...[...new Set(targets.plan_ids)].map((planId) => ({ campaignId, planId })),
        ...[...new Set(targets.customer_ids)].map((customerId) => ({ campaignId, customerId })),
      ],
    });
  }

  private async view(tx: Prisma.TransactionClient, row: CampaignRow): Promise<CampaignResponse> {
    const granted = await tx.creditGrant.aggregate({ where: { campaignId: row.id }, _sum: { amount: true }, _count: true });
    const spent = await tx.creditEntry.aggregate({
      where: { kind: { in: ['spend', 'give_back'] }, grant: { campaignId: row.id } },
      _sum: { amount: true },
    });
    const grantedCredits = granted._sum.amount ?? 0;
    return {
      id: row.id,
      name: row.name,
      credits_per_customer: row.creditsPerCustomer,
      credit_days: row.creditDays,
      starts_at: row.startsAt.toISOString(),
      ends_at: row.endsAt.toISOString(),
      budget: row.budget,
      status: row.status as CampaignStatus,
      targets: {
        plan_ids: row.targets.flatMap((target) => (target.planId ? [target.planId] : [])).sort(),
        customer_ids: row.targets.flatMap((target) => (target.customerId ? [target.customerId] : [])).sort(),
      },
      granted_customers: granted._count,
      granted_credits: grantedCredits,
      // Spends are negative and give-backs positive: what is still spent, as a positive number.
      spent_credits: -(spent._sum.amount ?? 0),
      budget_left: Math.max(0, row.budget - grantedCredits),
      budget_used_at: row.budgetUsedAt?.toISOString() ?? null,
    };
  }

  private async record(
    tx: Prisma.TransactionClient,
    auth: TenantAuth,
    id: string,
    before: CampaignResponse | undefined,
    after: CampaignResponse,
  ): Promise<void> {
    // Audited without the grant counts, which follow customers, not the change.
    const strip = ({ granted_customers: _c, granted_credits: _g, spent_credits: _s, budget_left: _b, budget_used_at: _u, ...rest }: CampaignResponse) =>
      rest;
    await this.audit.record(tx, {
      actor: { type: 'user', id: auth.userId },
      action: 'credit_campaign.changed',
      subject: { type: 'credit_campaign', id },
      before: before ? strip(before) : undefined,
      after: strip(after),
    });
  }
}
