import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { decodeCursor } from '../../common/pagination/cursor';
import { paginationQuerySchema, toPage } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import type { Partner, Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { PartnerAuth, TenantAuth } from '../identity/auth-context';
import { NotificationsService } from '../notifications/notifications.service';
import { PARTNER_STATUSES } from './partner-response';
import type { PartnerResponse, PartnerStatus, PayoutAccountState } from './partner-response';
import { ScoreService } from './score.service';

/** Who made a change: staff, or a partner person acting for the partner. */
type Actor = Pick<TenantAuth, 'tenantId' | 'userId'>;

const nameSchema = z.string().trim().min(1).max(200);

export const createPartnerSchema = z.object({ name: nameSchema, display_name: nameSchema });
export const updatePartnerSchema = z.object({ name: nameSchema.optional(), display_name: nameSchema.optional() });
export const agreementSchema = z.object({
  /** The signed agreement, uploaded through Files. */
  file_version_id: z.uuid(),
  signed_on: z.iso.date(),
});
export const partnerListQuerySchema = paginationQuerySchema.extend({ status: z.enum(PARTNER_STATUSES).optional() });
export type PartnerListQuery = z.infer<typeof partnerListQuerySchema>;

/** Files an agreement can be: uploaded, whether or not measuring has finished. */
const UPLOADED = ['uploaded', 'measuring', 'measured'];

/**
 * Locks the partner row for the rest of the transaction, which serialises changes to its people, setup
 * and prices. Row-level security hides other workspaces' partners, so a foreign id is not found.
 */
export async function lockPartner(tx: Prisma.TransactionClient, id: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM partner WHERE id = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) {
    throw new NotFoundException('Partner not found');
  }
}

/** Partner workshops, as staff manage them (Partners spec, goals 2 and 3). */
@Injectable()
export class PartnersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly score: ScoreService,
  ) {}

  async create(auth: TenantAuth, input: z.infer<typeof createPartnerSchema>): Promise<PartnerResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const row = await tx.partner.create({ data: { name: input.name, displayName: input.display_name } });
      const created = await this.audited(tx, row);
      await this.record(tx, auth, row.id, undefined, created);
      return { ...created, score: await this.score.scoreOf(tx, row.id), payout_account: 'not_connected' };
    });
  }

  async list(tenantId: string, query: PartnerListQuery): Promise<Page<PartnerResponse>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    return this.prisma.inTenant(tenantId, async (tx) => {
      const rows = await tx.partner.findMany({
        where: { ...(after ? { id: { lt: after.id } } : {}), ...(query.status ? { status: query.status } : {}) },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      });
      const page = toPage(rows, query.limit, secret);
      // One score run for the whole page.
      const scores = await this.score.scores(tx, page.data.map((row) => row.id));
      const payouts = await payoutStates(tx, page.data.map((row) => row.id));
      const data: PartnerResponse[] = [];
      for (const row of page.data) {
        data.push({ ...(await this.audited(tx, row)), score: scores.get(row.id)!, payout_account: payouts.get(row.id) ?? 'not_connected' });
      }
      return { data, next_cursor: page.next_cursor };
    });
  }

  async get(tenantId: string, id: string): Promise<PartnerResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const row = await this.find(tx, id);
      return { ...(await this.audited(tx, row)), score: await this.score.scoreOf(tx, id), payout_account: await payoutStateOf(tx, id) };
    });
  }

  async update(auth: TenantAuth, id: string, patch: z.infer<typeof updatePartnerSchema>): Promise<PartnerResponse> {
    return this.change(auth, id, () => ({ name: patch.name, displayName: patch.display_name }));
  }

  async setAgreement(auth: TenantAuth, id: string, input: z.infer<typeof agreementSchema>): Promise<PartnerResponse> {
    return this.change(auth, id, async (_, tx) => {
      const found = await tx.fileVersion.count({ where: { id: input.file_version_id, status: { in: UPLOADED } } });
      if (found === 0) {
        throw new NotFoundException('Agreement file not found');
      }
      return { agreementFileVersionId: input.file_version_id, agreementSignedOn: new Date(`${input.signed_on}T00:00:00Z`) };
    });
  }

  /** Only with a signed agreement on file; a suspended partner can be approved again. */
  async approve(auth: TenantAuth, id: string): Promise<PartnerResponse> {
    return this.change(auth, id, (row) => {
      if (row.status === 'approved') {
        throw new ConflictException('The partner is already approved');
      }
      if (!row.agreementFileVersionId) {
        throw new ConflictException('Put the signed agreement on file before approving');
      }
      return { status: 'approved' satisfies PartnerStatus };
    });
  }

  /**
   * The partner's owner says its setup is ready for approval. Staff hear it once: submitting again
   * while being set up changes nothing, and a partner never goes back to being set up.
   */
  async submit(auth: PartnerAuth): Promise<PartnerResponse> {
    const submitted = { first: false };
    const response = await this.change(auth, auth.partnerId, (row) => {
      if (row.status !== 'setting_up') {
        throw new ConflictException('Only a partner being set up can be submitted for approval');
      }
      submitted.first = row.submittedAt === null;
      return submitted.first ? { submittedAt: new Date() } : {};
    });
    // After commit, as invitations do: the notification never reports a change that rolled back.
    if (submitted.first) {
      await this.notifications.raise(auth.tenantId, 'partner.submitted', { type: 'partner', id: auth.partnerId }, {
        partner_name: response.display_name,
      });
    }
    return response;
  }

  /** No new offers; jobs already accepted carry on. */
  async suspend(auth: TenantAuth, id: string): Promise<PartnerResponse> {
    return this.change(auth, id, (row) => {
      if (row.status === 'suspended') {
        throw new ConflictException('The partner is already suspended');
      }
      return { status: 'suspended' satisfies PartnerStatus };
    });
  }

  /** Row-level security hides other workspaces' partners, so a foreign id is simply not found. */
  async find(tx: Prisma.TransactionClient, id: string): Promise<Partner> {
    const row = await tx.partner.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('Partner not found');
    }
    return row;
  }

  /** Locks the partner, applies `changes`, and audits the before and after. */
  private async change(
    auth: Actor,
    id: string,
    changes: (row: Partner, tx: Prisma.TransactionClient) => Prisma.PartnerUpdateInput | Promise<Prisma.PartnerUpdateInput>,
  ): Promise<PartnerResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await lockPartner(tx, id);
      const current = await this.find(tx, id);
      const before = await this.audited(tx, current);
      const row = await tx.partner.update({ where: { id }, data: await changes(current, tx) });
      const after = await this.audited(tx, row);
      await this.record(tx, auth, id, before, after);
      return { ...after, score: await this.score.scoreOf(tx, id), payout_account: await payoutStateOf(tx, id) };
    });
  }

  /**
   * The partner as audited: the response without its score and payout account, which are derived or
   * kept by others and change on their own.
   */
  private async audited(tx: Prisma.TransactionClient, row: Partner): Promise<Omit<PartnerResponse, 'score' | 'payout_account'>> {
    const memberCount = await tx.organisationMembership.count({ where: { organisationType: 'partner', organisationId: row.id } });
    return {
      id: row.id,
      name: row.name,
      display_name: row.displayName,
      status: row.status as PartnerStatus,
      accepts_direct_orders: row.acceptsDirectOrders,
      agreement:
        row.agreementFileVersionId && row.agreementSignedOn
          ? { file_version_id: row.agreementFileVersionId, signed_on: row.agreementSignedOn.toISOString().slice(0, 10) }
          : null,
      member_count: memberCount,
      submitted_at: row.submittedAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
    };
  }

  private record(
    tx: Prisma.TransactionClient,
    auth: Actor,
    id: string,
    before: Omit<PartnerResponse, 'score' | 'payout_account'> | undefined,
    after: Omit<PartnerResponse, 'score' | 'payout_account'>,
  ): Promise<void> {
    return this.audit.record(tx, {
      actor: { type: 'user', id: auth.userId },
      action: 'partner.changed',
      subject: { type: 'partner', id },
      before,
      after,
    });
  }
}

/** Where each partner's payout account stands at the provider, kept by Payments; no row is not connected. */
async function payoutStates(tx: Prisma.TransactionClient, partnerIds: string[]): Promise<Map<string, PayoutAccountState>> {
  const rows = await tx.partnerPayoutAccount.findMany({ where: { partnerId: { in: partnerIds } }, select: { partnerId: true, state: true } });
  return new Map(rows.map((row) => [row.partnerId, row.state as PayoutAccountState]));
}

async function payoutStateOf(tx: Prisma.TransactionClient, partnerId: string): Promise<PayoutAccountState> {
  return (await payoutStates(tx, [partnerId])).get(partnerId) ?? 'not_connected';
}
